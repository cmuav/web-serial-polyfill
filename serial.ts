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
}

export interface SerialPolyfillOptions {
  protocol?: SerialPolyfillProtocol;
  usbControlInterfaceClass?: number;
  usbTransferInterfaceClass?: number;
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

  public async open(options: SerialOptions): Promise<void> {
    this.serialOptions_ = options;
    this.validateOptions();
    try {
      await this.device_.open();
      if (this.device_.configuration === null) {
        await this.device_.selectConfiguration(1);
      }
      try { await this.device_.reset(); } catch { /* ok */ }
      if (!this.device_.opened) await this.device_.open();

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

  public async open(options: SerialOptions): Promise<void> {
    this.serialOptions_ = options;

    const dev = this.device_;
    try {
      await dev.open();
      if (dev.configuration === null) await dev.selectConfiguration(1);

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

// ── Detect protocol from device ──────────────────────────────────────────────

function isPL2303(device: USBDevice): boolean {
  return device.vendorId === PL2303_VENDOR_ID &&
      PL2303_PRODUCT_IDS.has(device.productId);
}

function createPort(
    device: USBDevice,
    polyfillOptions: SerialPolyfillOptions): SerialPort | PL2303SerialPort {
  if (isPL2303(device)) return new PL2303SerialPort(device);
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
  ): Promise<SerialPort | PL2303SerialPort> {
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
    // Include CDC-ACM class and known PL2303 vendor as defaults so both chip
    // families appear, then also add an exclusionFilters-free catch-all request
    // as a fallback for desktop browsers that support empty filters.
    if (usbFilters.length === 0) {
      usbFilters.push(
        {classCode: polyfillOptions.usbControlInterfaceClass},  // CDC-ACM
        {vendorId: PL2303_VENDOR_ID},                           // PL2303
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
      Promise<Array<SerialPort | PL2303SerialPort>> {
    polyfillOptions = {...kDefaultPolyfillOptions, ...polyfillOptions};
    const devices = await navigator.usb.getDevices();
    const ports: Array<SerialPort | PL2303SerialPort> = [];
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
