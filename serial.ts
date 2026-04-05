/*
 * Copyright 2019 Google LLC
 * Copyright 2026 cmuav
 *
 * Licensed under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in
 * compliance with the License. You may obtain a copy of
 * the License at
 *
 *    https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in
 * writing, software distributed under the License is
 * distributed on an "AS IS" BASIS, WITHOUT WARRANTIES
 * OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing
 * permissions and limitations under the License.
 */
'use strict';

// ── Public types ─────────────────────────────────────────────────────────────

export enum SerialPolyfillProtocol {
  UsbCdcAcm,
  UsbPl2303,
  UsbFtdi,
}

export interface SerialPolyfillOptions {
  protocol?: SerialPolyfillProtocol;
  usbControlInterfaceClass?: number;
  usbTransferInterfaceClass?: number;
}

export interface SerialOpenOptions extends SerialOptions {
  /** Send a USB device reset before claiming interfaces. Default: false. */
  resetUsb?: boolean;
}

// ── Shared constants ─────────────────────────────────────────────────────────

const kSetLineCoding = 0x20;
const kSetControlLineState = 0x22;
const kSendBreak = 0x23;

const kDefaultBufferSize = 255;
const kDefaultDataBits = 8;
const kDefaultParity = 'none';
const kDefaultStopBits = 1;

const kAcceptableDataBits = [16, 8, 7, 6, 5];
const kAcceptableStopBits = [1, 2];
const kAcceptableParity = ['none', 'even', 'odd'];

const kParityIndexMapping: ParityType[] = ['none', 'odd', 'even'];
const kStopBitsIndexMapping = [1, 1.5, 2];

const kDefaultPolyfillOptions = {
  protocol: SerialPolyfillProtocol.UsbCdcAcm,
  usbControlInterfaceClass: 2,
  usbTransferInterfaceClass: 10,
};

// ── PL2303 constants (from Linux kernel drivers/usb/serial/pl2303.c) ─────────

const PL2303_VENDOR_ID = 0x067b;
const PL2303_PRODUCT_IDS: Set<number> = new Set([
  0x2303, 0x2304, 0x04bb, 0x1234, 0xaaa0, 0xaaa2, 0xaaa8,
  0x0611, 0x0612, 0x0609, 0x331a, 0x0307, 0xe1f1,
  // G-series (HXN)
  0x23a3, 0x23b3, 0x23c3, 0x23d3, 0x23e3, 0x23f3,
]);
const PL2303_HXN_PRODUCT_IDS: Set<number> = new Set([
  0x23a3, 0x23b3, 0x23c3, 0x23d3, 0x23e3, 0x23f3,
]);
const PL2303_VENDOR_WRITE_REQUEST = 0x01;
const PL2303_VENDOR_WRITE_NREQUEST = 0x80;
const PL2303_VENDOR_WRITE_REQUEST_TYPE = 0x40;
const PL2303_VENDOR_READ_REQUEST = 0x01;
const PL2303_VENDOR_READ_REQUEST_TYPE = 0xc0;

// ── FTDI constants (from Linux kernel drivers/usb/serial/ftdi_sio.c) ────────

const FTDI_VENDOR_ID = 0x0403;
const FTDI_PRODUCT_IDS: Set<number> = new Set([
  0x6001, // FT232AM / FT232BM / FT232R
  0x6006, // FT232AM alternate
  0x6010, // FT2232C / FT2232D
  0x6011, // FT4232H
  0x6014, // FT232H
  0x6015, // FT-X series (FT230X, FT231X, etc.)
  0x6040, // FT2233HP
  0x6041, // FT4233HP
  0x6042, // FT2232HP
  0x6043, // FT4232HP
  0x6044, // FT233HP
  0x6045, // FT232HP
  0x6048, // FT4232HA
  0x8372, // SIO
]);

// Vendor control transfer requests
const FTDI_SIO_RESET          = 0;
const FTDI_SIO_MODEM_CTRL     = 1;
const FTDI_SIO_SET_FLOW_CTRL  = 2;
const FTDI_SIO_SET_BAUD_RATE  = 3;
const FTDI_SIO_SET_DATA       = 4;
const FTDI_SIO_SET_LATENCY    = 9;

// Reset sub-commands
const FTDI_SIO_RESET_SIO      = 0;
const FTDI_SIO_RESET_PURGE_RX = 1;
const FTDI_SIO_RESET_PURGE_TX = 2;

// Modem control
const FTDI_SIO_SET_DTR_HIGH = (0x1 << 8) | 1;
const FTDI_SIO_SET_DTR_LOW  = (0x1 << 8) | 0;
const FTDI_SIO_SET_RTS_HIGH = (0x2 << 8) | 2;
const FTDI_SIO_SET_RTS_LOW  = (0x2 << 8) | 0;

// SET_DATA bit fields
const FTDI_SIO_SET_DATA_PARITY_NONE = 0x0 << 8;
const FTDI_SIO_SET_DATA_PARITY_ODD  = 0x1 << 8;
const FTDI_SIO_SET_DATA_PARITY_EVEN = 0x2 << 8;
const FTDI_SIO_SET_DATA_STOP_BITS_1 = 0x0 << 11;
const FTDI_SIO_SET_DATA_STOP_BITS_2 = 0x2 << 11;
const FTDI_SIO_SET_BREAK            = 0x1 << 14;

// Chip types determined from bcdDevice
const enum FtdiChipType {
  SIO,       // bcdDevice < 0x200
  FT232A,    // 0x200
  FT232B,    // 0x400
  FT2232C,   // 0x500
  FT232R,    // 0x600
  FT2232H,   // 0x700 (hi-speed)
  FT4232H,   // 0x800 (hi-speed)
  FT232H,    // 0x900 (hi-speed)
  FTX,       // 0x1000
  FTHiSpeed, // 0x2800+ (HP series, etc.)
}

function ftdiDetectChip(device: USBDevice): FtdiChipType {
  const bcd = (device.deviceVersionMajor << 8) |
              (device.deviceVersionMinor << 4) |
              device.deviceVersionSubminor;
  if (bcd < 0x200) return FtdiChipType.SIO;
  switch (bcd) {
    case 0x200: return FtdiChipType.FT232A;
    case 0x400: return FtdiChipType.FT232B;
    case 0x500: return FtdiChipType.FT2232C;
    case 0x600: return FtdiChipType.FT232R;
    case 0x700: return FtdiChipType.FT2232H;
    case 0x800: return FtdiChipType.FT4232H;
    case 0x900: return FtdiChipType.FT232H;
    case 0x1000: return FtdiChipType.FTX;
    default:    return FtdiChipType.FTHiSpeed;
  }
}

function ftdiIsHiSpeed(chip: FtdiChipType): boolean {
  return chip === FtdiChipType.FT2232H ||
         chip === FtdiChipType.FT4232H ||
         chip === FtdiChipType.FT232H ||
         chip === FtdiChipType.FTHiSpeed;
}

// ── FTDI baud rate divisor calculation ──────────────────────────────────────

function ftdi232bmDivisor(baud: number, base: number): number {
  const divfrac = [0, 3, 2, 4, 1, 5, 6, 7];
  const divisor3 = Math.round(base / (2 * baud));
  let divisor = divisor3 >> 3;
  divisor |= divfrac[divisor3 & 0x7] << 14;
  if (divisor === 1) divisor = 0;
  else if (divisor === 0x4001) divisor = 1;
  return divisor;
}

function ftdi2232hDivisor(baud: number, base: number): number {
  const divfrac = [0, 3, 2, 4, 1, 5, 6, 7];
  const divisor3 = Math.round((8 * base) / (10 * baud));
  let divisor = divisor3 >> 3;
  divisor |= divfrac[divisor3 & 0x7] << 14;
  if (divisor === 1) divisor = 0;
  else if (divisor === 0x4001) divisor = 1;
  divisor |= 0x00020000; // disable /2.5 prescaler for hi-speed
  return divisor;
}

function ftdiGetDivisor(chip: FtdiChipType, baud: number): number {
  if (ftdiIsHiSpeed(chip)) {
    if (baud >= 1200 && baud <= 12000000) return ftdi2232hDivisor(baud, 120000000);
    return ftdi232bmDivisor(baud, 48000000);
  }
  return ftdi232bmDivisor(baud, 48000000);
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function findInterface(device: USBDevice, classCode: number): USBInterface {
  const configuration = device.configurations[0];
  for (const iface of configuration.interfaces) {
    const alternate = iface.alternates[0];
    if (alternate.interfaceClass === classCode) {
      return iface;
    }
  }
  throw new TypeError(`Unable to find interface with class ${classCode}.`);
}

function findEndpoint(
    iface: USBInterface, direction: USBDirection): USBEndpoint {
  const alternate = iface.alternates[0];
  for (const endpoint of alternate.endpoints) {
    if (endpoint.direction == direction) {
      return endpoint;
    }
  }
  throw new TypeError(`Interface ${iface.interfaceNumber} does not have an ` +
                      `${direction} endpoint.`);
}

function findBulkInterface(device: USBDevice): USBInterface | null {
  const config = device.configurations[0];
  for (const iface of config.interfaces) {
    const alt = iface.alternates[0];
    const hasIn = alt.endpoints.some(
        (e) => e.direction === 'in' && e.type === 'bulk');
    const hasOut = alt.endpoints.some(
        (e) => e.direction === 'out' && e.type === 'bulk');
    if (hasIn && hasOut) return iface;
  }
  return null;
}

// ── Stream helpers ───────────────────────────────────────────────────────────

class UsbEndpointUnderlyingSource implements UnderlyingByteSource {
  private device_: USBDevice;
  private endpoint_: USBEndpoint;
  private onError_: () => void;
  type: 'bytes';

  constructor(device: USBDevice, endpoint: USBEndpoint, onError: () => void) {
    this.type = 'bytes';
    this.device_ = device;
    this.endpoint_ = endpoint;
    this.onError_ = onError;
  }

  pull(controller: ReadableByteStreamController): void {
    (async (): Promise<void> => {
      let chunkSize;
      if (controller.desiredSize) {
        const d = controller.desiredSize / this.endpoint_.packetSize;
        chunkSize = Math.ceil(d) * this.endpoint_.packetSize;
      } else {
        chunkSize = this.endpoint_.packetSize;
      }
      try {
        const result = await this.device_.transferIn(
            this.endpoint_.endpointNumber, chunkSize);
        if (result.status != 'ok') {
          controller.error(`USB error: ${result.status}`);
          this.onError_();
        }
        if (result.data?.buffer) {
          const chunk = new Uint8Array(
              result.data.buffer, result.data.byteOffset,
              result.data.byteLength);
          controller.enqueue(chunk);
        }
      } catch (error) {
        controller.error((error as Error).toString());
        this.onError_();
      }
    })();
  }
}

class UsbEndpointUnderlyingSink implements UnderlyingSink<Uint8Array> {
  private device_: USBDevice;
  private endpoint_: USBEndpoint;
  private onError_: () => void;

  constructor(device: USBDevice, endpoint: USBEndpoint, onError: () => void) {
    this.device_ = device;
    this.endpoint_ = endpoint;
    this.onError_ = onError;
  }

  async write(
      chunk: Uint8Array,
      controller: WritableStreamDefaultController): Promise<void> {
    try {
      const result =
          await this.device_.transferOut(
              this.endpoint_.endpointNumber, chunk as unknown as BufferSource);
      if (result.status != 'ok') {
        controller.error(result.status);
        this.onError_();
      }
    } catch (error) {
      controller.error((error as Error).toString());
      this.onError_();
    }
  }
}

// ── CDC-ACM SerialPort ───────────────────────────────────────────────────────

/** SerialPort for USB CDC-ACM devices (the original polyfill). */
export class SerialPort {
  private polyfillOptions_: SerialPolyfillOptions;
  private device_: USBDevice;
  private controlInterface_: USBInterface;
  private transferInterface_: USBInterface;
  private inEndpoint_: USBEndpoint;
  private outEndpoint_: USBEndpoint;

  private serialOptions_!: SerialOptions;
  private readable_: ReadableStream<Uint8Array> | null = null;
  private writable_: WritableStream<Uint8Array> | null = null;
  private outputSignals_: SerialOutputSignals;

  public constructor(
      device: USBDevice, polyfillOptions?: SerialPolyfillOptions) {
    this.polyfillOptions_ = {...kDefaultPolyfillOptions, ...polyfillOptions};
    this.outputSignals_ = {
      dataTerminalReady: false,
      requestToSend: false,
      break: false,
    };
    this.device_ = device;
    this.controlInterface_ = findInterface(
        this.device_,
        this.polyfillOptions_.usbControlInterfaceClass as number);
    this.transferInterface_ = findInterface(
        this.device_,
        this.polyfillOptions_.usbTransferInterfaceClass as number);
    this.inEndpoint_ = findEndpoint(this.transferInterface_, 'in');
    this.outEndpoint_ = findEndpoint(this.transferInterface_, 'out');
  }

  public get readable(): ReadableStream<Uint8Array> | null {
    if (!this.readable_ && this.device_.opened) {
      this.readable_ = new ReadableStream<Uint8Array>(
          new UsbEndpointUnderlyingSource(
              this.device_, this.inEndpoint_, () => {
                this.readable_ = null;
              }),
          {highWaterMark: this.serialOptions_.bufferSize ?? kDefaultBufferSize});
    }
    return this.readable_;
  }

  public get writable(): WritableStream<Uint8Array> | null {
    if (!this.writable_ && this.device_.opened) {
      this.writable_ = new WritableStream(
          new UsbEndpointUnderlyingSink(
              this.device_, this.outEndpoint_, () => {
                this.writable_ = null;
              }),
          new ByteLengthQueuingStrategy({
            highWaterMark: this.serialOptions_.bufferSize ?? kDefaultBufferSize,
          }));
    }
    return this.writable_;
  }

  public async open(options: SerialOpenOptions): Promise<void> {
    this.serialOptions_ = options;
    this.validateOptions();
    try {
      await this.device_.open();
      if (this.device_.configuration === null) {
        await this.device_.selectConfiguration(1);
      }
      if (options.resetUsb) {
        try { await this.device_.reset(); } catch { /* ok */ }
        if (!this.device_.opened) await this.device_.open();
      }

      await this.device_.claimInterface(
          this.controlInterface_.interfaceNumber);
      if (this.controlInterface_ !== this.transferInterface_) {
        await this.device_.claimInterface(
            this.transferInterface_.interfaceNumber);
      }
      await this.setLineCoding();
      await this.setSignals({dataTerminalReady: true});
    } catch (error) {
      if (this.device_.opened) await this.device_.close();
      throw new Error('Error setting up device: ' + (error as Error).toString());
    }
  }

  public async close(): Promise<void> {
    const promises: Promise<void>[] = [];
    if (this.readable_) promises.push(this.readable_.cancel());
    if (this.writable_) promises.push(this.writable_.abort());
    await Promise.all(promises);
    this.readable_ = null;
    this.writable_ = null;
    if (this.device_.opened) {
      await this.setSignals({dataTerminalReady: false, requestToSend: false});
      await this.device_.close();
    }
  }

  public async forget(): Promise<void> {
    return this.device_.forget();
  }

  public getInfo(): SerialPortInfo {
    return {
      usbVendorId: this.device_.vendorId,
      usbProductId: this.device_.productId,
    };
  }

  public reconfigure(options: SerialOptions): Promise<void> {
    this.serialOptions_ = {...this.serialOptions_, ...options};
    this.validateOptions();
    return this.setLineCoding();
  }

  public async setSignals(signals: SerialOutputSignals): Promise<void> {
    this.outputSignals_ = {...this.outputSignals_, ...signals};
    if (signals.dataTerminalReady !== undefined ||
        signals.requestToSend !== undefined) {
      const value = (this.outputSignals_.dataTerminalReady ? 1 << 0 : 0) |
                    (this.outputSignals_.requestToSend ? 1 << 1 : 0);
      await this.device_.controlTransferOut({
        'requestType': 'class', 'recipient': 'interface',
        'request': kSetControlLineState, 'value': value,
        'index': this.controlInterface_.interfaceNumber,
      });
    }
    if (signals.break !== undefined) {
      const value = this.outputSignals_.break ? 0xFFFF : 0x0000;
      await this.device_.controlTransferOut({
        'requestType': 'class', 'recipient': 'interface',
        'request': kSendBreak, 'value': value,
        'index': this.controlInterface_.interfaceNumber,
      });
    }
  }

  private validateOptions(): void {
    if (!this.isValidBaudRate(this.serialOptions_.baudRate))
      throw new RangeError('invalid Baud Rate ' + this.serialOptions_.baudRate);
    if (!this.isValidDataBits(this.serialOptions_.dataBits))
      throw new RangeError('invalid dataBits ' + this.serialOptions_.dataBits);
    if (!this.isValidStopBits(this.serialOptions_.stopBits))
      throw new RangeError('invalid stopBits ' + this.serialOptions_.stopBits);
    if (!this.isValidParity(this.serialOptions_.parity))
      throw new RangeError('invalid parity ' + this.serialOptions_.parity);
  }

  private isValidBaudRate(baudRate: number): boolean {
    return baudRate % 1 === 0;
  }
  private isValidDataBits(dataBits: number | undefined): boolean {
    return typeof dataBits === 'undefined' || kAcceptableDataBits.includes(dataBits);
  }
  private isValidStopBits(stopBits: number | undefined): boolean {
    return typeof stopBits === 'undefined' || kAcceptableStopBits.includes(stopBits);
  }
  private isValidParity(parity: ParityType | undefined): boolean {
    return typeof parity === 'undefined' || kAcceptableParity.includes(parity);
  }

  private async setLineCoding(): Promise<void> {
    const buffer = new ArrayBuffer(7);
    const view = new DataView(buffer);
    view.setUint32(0, this.serialOptions_.baudRate, true);
    view.setUint8(4, kStopBitsIndexMapping.indexOf(
        this.serialOptions_.stopBits ?? kDefaultStopBits));
    view.setUint8(5, kParityIndexMapping.indexOf(
        this.serialOptions_.parity ?? kDefaultParity));
    view.setUint8(6, this.serialOptions_.dataBits ?? kDefaultDataBits);
    const result = await this.device_.controlTransferOut({
      'requestType': 'class', 'recipient': 'interface',
      'request': kSetLineCoding, 'value': 0x00,
      'index': this.controlInterface_.interfaceNumber,
    }, buffer);
    if (result.status != 'ok')
      throw new DOMException('NetworkError', 'Failed to set line coding.');
  }
}

// ── PL2303 SerialPort ────────────────────────────────────────────────────────

/**
 * SerialPort for Prolific PL2303 USB-to-serial adapters.
 *
 * Implements the PL2303 vendor protocol (including HXN/G-series variants)
 * directly over WebUSB, bypassing the need for OS kernel drivers.
 *
 * Reference: Linux kernel drivers/usb/serial/pl2303.c
 */
export class PL2303SerialPort {
  private device_: USBDevice;
  private isHXN_: boolean;
  private inEndpoint_!: USBEndpoint;
  private outEndpoint_!: USBEndpoint;

  private serialOptions_!: SerialOptions;
  private readable_: ReadableStream<Uint8Array> | null = null;
  private writable_: WritableStream<Uint8Array> | null = null;

  public constructor(device: USBDevice) {
    this.device_ = device;
    this.isHXN_ = PL2303_HXN_PRODUCT_IDS.has(device.productId);
  }

  public get readable(): ReadableStream<Uint8Array> | null {
    if (!this.readable_ && this.device_.opened) {
      this.readable_ = new ReadableStream<Uint8Array>(
          new UsbEndpointUnderlyingSource(
              this.device_, this.inEndpoint_, () => {
                this.readable_ = null;
              }),
          {highWaterMark: this.serialOptions_.bufferSize ?? kDefaultBufferSize});
    }
    return this.readable_;
  }

  public get writable(): WritableStream<Uint8Array> | null {
    if (!this.writable_ && this.device_.opened) {
      this.writable_ = new WritableStream(
          new UsbEndpointUnderlyingSink(
              this.device_, this.outEndpoint_, () => {
                this.writable_ = null;
              }),
          new ByteLengthQueuingStrategy({
            highWaterMark: this.serialOptions_.bufferSize ?? kDefaultBufferSize,
          }));
    }
    return this.writable_;
  }

  public async open(options: SerialOpenOptions): Promise<void> {
    this.serialOptions_ = options;

    const dev = this.device_;
    try {
      await dev.open();
      if (dev.configuration === null) await dev.selectConfiguration(1);
      if (options.resetUsb) {
        try { await dev.reset(); } catch { /* ok */ }
        if (!dev.opened) await dev.open();
      }

      // Find bulk data interface
      const dataIface = findBulkInterface(dev);
      if (!dataIface)
        throw new Error('PL2303: No data interface with bulk endpoints found');

      const alt = dataIface.alternates[0];
      this.inEndpoint_ = alt.endpoints.find(
          (e) => e.direction === 'in' && e.type === 'bulk')!;
      this.outEndpoint_ = alt.endpoints.find(
          (e) => e.direction === 'out' && e.type === 'bulk')!;

      // Claim all interfaces
      for (const iface of dev.configuration!.interfaces) {
        await dev.claimInterface(iface.interfaceNumber);
      }

      // PL2303 init sequence
      await this.initChip_();

      // Set line coding: baud, 8N1
      await this.setLineCoding_(options.baudRate,
          options.dataBits ?? kDefaultDataBits,
          kStopBitsIndexMapping.indexOf(options.stopBits ?? kDefaultStopBits),
          kParityIndexMapping.indexOf(options.parity ?? kDefaultParity));

      // Enable DTR + RTS
      await this.setControlLines_(0x01 | 0x02);

      // HXN post-init
      if (this.isHXN_) await this.vendorWrite_(7, 0x07);
    } catch (error) {
      if (dev.opened) await dev.close();
      throw new Error(
          'Error setting up PL2303 device: ' + (error as Error).toString());
    }
  }

  public async close(): Promise<void> {
    const promises: Promise<void>[] = [];
    if (this.readable_) promises.push(this.readable_.cancel());
    if (this.writable_) promises.push(this.writable_.abort());
    await Promise.all(promises);
    this.readable_ = null;
    this.writable_ = null;
    if (this.device_.opened) {
      try { await this.setControlLines_(0); } catch { /* ok */ }
      await this.device_.close();
    }
  }

  public async forget(): Promise<void> {
    return this.device_.forget();
  }

  public getInfo(): SerialPortInfo {
    return {
      usbVendorId: this.device_.vendorId,
      usbProductId: this.device_.productId,
    };
  }

  // ── PL2303 init (from kernel pl2303_startup) ──────────────────────────────

  private async initChip_(): Promise<void> {
    if (this.isHXN_) return; // G-series needs no init sequence

    // Classic PL2303/HX init handshake
    const buf = new Uint8Array(1);
    await this.vendorRead_(0x8484, buf);
    await this.vendorWrite_(0x0404, 0);
    await this.vendorRead_(0x8484, buf);
    await this.vendorRead_(0x8383, buf);
    await this.vendorRead_(0x8484, buf);
    await this.vendorWrite_(0x0404, 1);
    await this.vendorRead_(0x8484, buf);
    await this.vendorRead_(0x8383, buf);
    await this.vendorWrite_(0, 1);
    await this.vendorWrite_(1, 0);
    await this.vendorWrite_(2, 0x44);
  }

  private async vendorWrite_(value: number, index: number): Promise<void> {
    const request = this.isHXN_ ?
        PL2303_VENDOR_WRITE_NREQUEST : PL2303_VENDOR_WRITE_REQUEST;
    await this.device_.controlTransferOut({
      requestType: 'vendor', recipient: 'device',
      request, value, index,
    });
  }

  private async vendorRead_(value: number, buf: Uint8Array): Promise<void> {
    const request = this.isHXN_ ?
        PL2303_VENDOR_WRITE_NREQUEST : PL2303_VENDOR_READ_REQUEST;
    const result = await this.device_.controlTransferIn({
      requestType: 'vendor', recipient: 'device',
      request, value, index: 0,
    }, buf.length);
    if (result.data) {
      const src = new Uint8Array(
          result.data.buffer, result.data.byteOffset, result.data.byteLength);
      buf.set(src.subarray(0, buf.length));
    }
  }

  private async setLineCoding_(
      baudRate: number, dataBits: number,
      stopBits: number, parity: number): Promise<void> {
    const buffer = new ArrayBuffer(7);
    const view = new DataView(buffer);
    view.setUint32(0, baudRate, true);
    view.setUint8(4, stopBits);
    view.setUint8(5, parity);
    view.setUint8(6, dataBits);
    await this.device_.controlTransferOut({
      requestType: 'class', recipient: 'interface',
      request: kSetLineCoding, value: 0, index: 0,
    }, buffer);
  }

  private async setControlLines_(value: number): Promise<void> {
    await this.device_.controlTransferOut({
      requestType: 'class', recipient: 'interface',
      request: kSetControlLineState, value, index: 0,
    });
  }
}

// ── FTDI SerialPort ─────────────────────────────────────────────────────────

/**
 * SerialPort for FTDI USB-to-serial adapters.
 *
 * Implements the FTDI vendor protocol directly over WebUSB, handling the
 * proprietary baud rate divisor encoding and per-packet status byte stripping.
 *
 * Reference: Linux kernel drivers/usb/serial/ftdi_sio.c
 */
export class FTDISerialPort {
  private device_: USBDevice;
  private chip_: FtdiChipType;
  private channel_: number;       // 0 for single-port, 1+ for multi-port chips
  private inEndpoint_!: USBEndpoint;
  private outEndpoint_!: USBEndpoint;
  private maxPacketSize_!: number;

  private serialOptions_!: SerialOptions;
  private lastSetDataValue_: number = 0;
  private readable_: ReadableStream<Uint8Array> | null = null;
  private writable_: WritableStream<Uint8Array> | null = null;

  public constructor(device: USBDevice) {
    this.device_ = device;
    this.chip_ = ftdiDetectChip(device);
    this.channel_ = 0;
  }

  public get readable(): ReadableStream<Uint8Array> | null {
    if (!this.readable_ && this.device_.opened) {
      const device = this.device_;
      const ep = this.inEndpoint_;
      const maxPkt = this.maxPacketSize_;

      // Custom source that strips the 2-byte modem/line status header
      // that FTDI chips prepend to every USB packet.
      this.readable_ = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await device.transferIn(
                ep.endpointNumber, maxPkt);
            if (result.status !== 'ok') {
              controller.error(`USB error: ${result.status}`);
              return;
            }
            if (!result.data || result.data.byteLength < 2) return;

            const raw = new Uint8Array(
                result.data.buffer, result.data.byteOffset,
                result.data.byteLength);

            // Strip 2-byte status header from each max_packet_size chunk
            const chunks: Uint8Array[] = [];
            for (let i = 0; i < raw.length; i += maxPkt) {
              const end = Math.min(i + maxPkt, raw.length);
              if (end - i > 2) {
                chunks.push(raw.subarray(i + 2, end));
              }
            }
            if (chunks.length === 1) {
              controller.enqueue(chunks[0]);
            } else if (chunks.length > 1) {
              let total = 0;
              for (const c of chunks) total += c.length;
              const merged = new Uint8Array(total);
              let off = 0;
              for (const c of chunks) { merged.set(c, off); off += c.length; }
              controller.enqueue(merged);
            }
          } catch (error) {
            controller.error((error as Error).toString());
          }
        },
      }, {
        highWaterMark: this.serialOptions_.bufferSize ?? kDefaultBufferSize,
      });
    }
    return this.readable_;
  }

  public get writable(): WritableStream<Uint8Array> | null {
    if (!this.writable_ && this.device_.opened) {
      this.writable_ = new WritableStream(
          new UsbEndpointUnderlyingSink(
              this.device_, this.outEndpoint_, () => {
                this.writable_ = null;
              }),
          new ByteLengthQueuingStrategy({
            highWaterMark: this.serialOptions_.bufferSize ?? kDefaultBufferSize,
          }));
    }
    return this.writable_;
  }

  public async open(options: SerialOpenOptions): Promise<void> {
    this.serialOptions_ = options;
    const dev = this.device_;

    try {
      await dev.open();
      if (dev.configuration === null) await dev.selectConfiguration(1);
      if (options.resetUsb) {
        try { await dev.reset(); } catch { /* ok */ }
        if (!dev.opened) await dev.open();
      }

      // Find the data interface with bulk IN/OUT endpoints.
      // FTDI uses vendor-specific class (0xFF).
      const dataIface = findBulkInterface(dev);
      if (!dataIface)
        throw new Error('FTDI: No data interface with bulk endpoints found');

      // For multi-channel chips, the channel is interface number + 1
      const ifnum = dataIface.interfaceNumber;
      this.channel_ = (this.chip_ === FtdiChipType.FT2232C ||
                       this.chip_ === FtdiChipType.FT2232H ||
                       this.chip_ === FtdiChipType.FT4232H ||
                       this.chip_ === FtdiChipType.FTHiSpeed)
          ? ifnum + 1 : 0;

      const alt = dataIface.alternates[0];
      this.inEndpoint_ = alt.endpoints.find(
          (e) => e.direction === 'in' && e.type === 'bulk')!;
      this.outEndpoint_ = alt.endpoints.find(
          (e) => e.direction === 'out' && e.type === 'bulk')!;
      this.maxPacketSize_ = this.inEndpoint_.packetSize || 64;

      // Claim all interfaces
      for (const iface of dev.configuration!.interfaces) {
        await dev.claimInterface(iface.interfaceNumber);
      }

      // Reset the device
      await this.vendorOut_(FTDI_SIO_RESET, FTDI_SIO_RESET_SIO);

      // Set baud rate
      await this.setBaudRate_(options.baudRate);

      // Set data format (8N1 default)
      await this.setDataCharacteristics_(
          options.dataBits ?? kDefaultDataBits,
          options.parity ?? kDefaultParity,
          options.stopBits ?? kDefaultStopBits);

      // Disable flow control
      await this.vendorOutIndex_(FTDI_SIO_SET_FLOW_CTRL, 0, 0);

      // Set DTR + RTS
      await this.vendorOut_(FTDI_SIO_MODEM_CTRL, FTDI_SIO_SET_DTR_HIGH);
      await this.vendorOut_(FTDI_SIO_MODEM_CTRL, FTDI_SIO_SET_RTS_HIGH);

      // Set latency timer to 16ms (default)
      await this.vendorOut_(FTDI_SIO_SET_LATENCY, 16);

      // Purge buffers
      await this.vendorOut_(FTDI_SIO_RESET, FTDI_SIO_RESET_PURGE_RX);
      await this.vendorOut_(FTDI_SIO_RESET, FTDI_SIO_RESET_PURGE_TX);
    } catch (error) {
      if (dev.opened) await dev.close();
      throw new Error(
          'Error setting up FTDI device: ' + (error as Error).toString());
    }
  }

  public async close(): Promise<void> {
    const promises: Promise<void>[] = [];
    if (this.readable_) promises.push(this.readable_.cancel());
    if (this.writable_) promises.push(this.writable_.abort());
    await Promise.all(promises);
    this.readable_ = null;
    this.writable_ = null;
    if (this.device_.opened) {
      try {
        await this.vendorOut_(FTDI_SIO_MODEM_CTRL, FTDI_SIO_SET_DTR_LOW);
        await this.vendorOut_(FTDI_SIO_MODEM_CTRL, FTDI_SIO_SET_RTS_LOW);
      } catch { /* ok */ }
      await this.device_.close();
    }
  }

  public async forget(): Promise<void> {
    return this.device_.forget();
  }

  public getInfo(): SerialPortInfo {
    return {
      usbVendorId: this.device_.vendorId,
      usbProductId: this.device_.productId,
    };
  }

  // ── FTDI vendor control transfers ─────────────────────────────────────────

  private async vendorOut_(request: number, value: number): Promise<void> {
    await this.device_.controlTransferOut({
      requestType: 'vendor', recipient: 'device',
      request, value, index: this.channel_,
    });
  }

  private async vendorOutIndex_(
      request: number, value: number, index: number): Promise<void> {
    // For multi-channel chips, channel goes in the low byte of wIndex
    const idx = this.channel_ ? ((index << 8) | this.channel_) : index;
    await this.device_.controlTransferOut({
      requestType: 'vendor', recipient: 'device',
      request, value, index: idx,
    });
  }

  private async setBaudRate_(baud: number): Promise<void> {
    const indexValue = ftdiGetDivisor(this.chip_, baud);
    const value = indexValue & 0xFFFF;
    const index = (indexValue >> 16) & 0xFFFF;
    await this.vendorOutIndex_(FTDI_SIO_SET_BAUD_RATE, value, index);
  }

  private async setDataCharacteristics_(
      dataBits: number, parity: string, stopBits: number): Promise<void> {
    let value = dataBits & 0xFF;
    switch (parity) {
      case 'odd':  value |= FTDI_SIO_SET_DATA_PARITY_ODD;  break;
      case 'even': value |= FTDI_SIO_SET_DATA_PARITY_EVEN; break;
      default:     value |= FTDI_SIO_SET_DATA_PARITY_NONE;  break;
    }
    value |= (stopBits === 2)
        ? FTDI_SIO_SET_DATA_STOP_BITS_2
        : FTDI_SIO_SET_DATA_STOP_BITS_1;
    this.lastSetDataValue_ = value;
    await this.vendorOut_(FTDI_SIO_SET_DATA, value);
  }
}

// ── Detect protocol from device ──────────────────────────────────────────────

function isPL2303(device: USBDevice): boolean {
  return device.vendorId === PL2303_VENDOR_ID &&
      PL2303_PRODUCT_IDS.has(device.productId);
}

function isFTDI(device: USBDevice): boolean {
  if (device.vendorId === FTDI_VENDOR_ID &&
      FTDI_PRODUCT_IDS.has(device.productId)) return true;
  // Also detect by vendor-specific interface class (0xFF) with FTDI VID
  if (device.vendorId === FTDI_VENDOR_ID) {
    const config = device.configurations[0];
    if (config) {
      for (const iface of config.interfaces) {
        if (iface.alternates[0]?.interfaceClass === 0xFF) return true;
      }
    }
  }
  return false;
}

type AnySerialPort = SerialPort | PL2303SerialPort | FTDISerialPort;

function createPort(
    device: USBDevice,
    polyfillOptions: SerialPolyfillOptions): AnySerialPort {
  if (isPL2303(device)) return new PL2303SerialPort(device);
  if (isFTDI(device)) return new FTDISerialPort(device);
  return new SerialPort(device, polyfillOptions);
}

// ── Serial (navigator.serial replacement) ────────────────────────────────────

class Serial {
  /**
   * Requests permission to access a port.
   *
   * Shows ALL connected USB devices in the picker — no filtering.
   * PL2303 devices are auto-detected and get the PL2303 driver;
   * everything else is treated as CDC-ACM.
   */
  async requestPort(
      options?: SerialPortRequestOptions,
      polyfillOptions?: SerialPolyfillOptions,
  ): Promise<AnySerialPort> {
    polyfillOptions = {...kDefaultPolyfillOptions, ...polyfillOptions};

    // Build USB filters from serial filters if provided
    const usbFilters: USBDeviceFilter[] = [];
    if (options?.filters) {
      for (const filter of options.filters) {
        const usbFilter: USBDeviceFilter = {};
        if (filter.usbVendorId !== undefined) usbFilter.vendorId = filter.usbVendorId;
        if (filter.usbProductId !== undefined) usbFilter.productId = filter.usbProductId;
        usbFilters.push(usbFilter);
      }
    }

    // Android WebUSB requires at least one filter to show devices in the picker.
    // Use vendor ID filters for known USB-serial chips since classCode filters
    // can be unreliable on Android.
    if (usbFilters.length === 0) {
      usbFilters.push(
        {vendorId: PL2303_VENDOR_ID},   // Prolific PL2303
        {vendorId: 0x0403},             // FTDI
        {vendorId: 0x1a86},             // QinHeng CH340/CH341
        {vendorId: 0x10c4},             // Silicon Labs CP210x
        {vendorId: 0x2341},             // Arduino
        {vendorId: 0x239a},             // Adafruit
        {vendorId: 0x2e8a},             // Raspberry Pi Pico
        {vendorId: 0x3483},             // STMicroelectronics
        {vendorId: 0x26ac},             // CubePilot/ProfiCNC
        {vendorId: 0x1209},             // Generic USB (pid.codes)
        {vendorId: 0x27ac},             // CubePilot (alternate)
      );
    }

    let device: USBDevice;
    try {
      device = await navigator.usb.requestDevice({filters: usbFilters});
    } catch (e) {
      // If filtered request fails (e.g. no matching devices), try unfiltered
      // for browsers that support it (desktop Chrome)
      if ((e as Error).name === 'NotFoundError') {
        device = await navigator.usb.requestDevice({filters: []});
      } else {
        throw e;
      }
    }
    return createPort(device, polyfillOptions);
  }

  async getPorts(polyfillOptions?: SerialPolyfillOptions):
      Promise<AnySerialPort[]> {
    polyfillOptions = {...kDefaultPolyfillOptions, ...polyfillOptions};
    const devices = await navigator.usb.getDevices();
    const ports: AnySerialPort[] = [];
    for (const device of devices) {
      try {
        ports.push(createPort(device, polyfillOptions));
      } catch {
        // Skip unrecognized device
      }
    }
    return ports;
  }
}

export const serial = new Serial();
