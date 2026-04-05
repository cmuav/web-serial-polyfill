# Web Serial Polyfill

A [Web Serial API](https://wicg.github.io/serial) implementation over [WebUSB](https://wicg.github.io/webusb) for USB-to-serial adapters. Useful on platforms like Android that support WebUSB but not Web Serial.

Fork of [google/web-serial-polyfill](https://github.com/nicedoc/nicedoc/blob/master/nicedoc.io/guides/web-serial-polyfill.md) with added support for PL2303 and FTDI chips.

## Supported hardware

| Chip family | Class | Examples |
|---|---|---|
| **CDC-ACM** | Standard USB serial | Arduino, STM32, RP2040, CP210x (some) |
| **Prolific PL2303** | Vendor (incl. HXN/G-series) | PL2303, PL2303HX, PL2303GC/GB/GT/GL/GE/GS |
| **FTDI** | Vendor | FT232R, FT232H, FT2232H, FT4232H, FT230X/FT231X, FT233HP/FT232HP |

Chip type is auto-detected from the USB vendor/product ID. No configuration required.

## Install

```bash
npm install @cmuav/web-serial-polyfill
```

## Usage

```ts
import { serial } from '@cmuav/web-serial-polyfill';

// Prompt user to pick a USB device
const port = await serial.requestPort();
await port.open({ baudRate: 115200 });

// Read
const reader = port.readable!.getReader();
const { value } = await reader.read();
reader.releaseLock();

// Write
const writer = port.writable!.getWriter();
await writer.write(new Uint8Array([0x01, 0x02]));
writer.releaseLock();

await port.close();
```

## FTDI details

The FTDI driver handles:

- **Chip detection** via `bcdDevice` — SIO, FT232A/B/R, FT2232C/H, FT4232H, FT232H, FTX, and HP-series
- **Baud rate divisor encoding** — 232BM algorithm (48 MHz) for standard chips, 2232H algorithm (120 MHz) for hi-speed chips
- **Status byte stripping** — FTDI prepends 2 bytes (modem + line status) per USB packet; these are automatically removed from the readable stream
- **Multi-channel** — correct `wIndex` channel encoding for FT2232/FT4232 multi-port devices

## Development

```bash
npm install
npm run build
```

## License

Apache-2.0
