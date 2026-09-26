import { TminiParser } from './usb-protocol.js';

const BOOT_MS = 2200;
const REPLY_MS = 1000;
const MODEL = 151;
const COMMAND = { stop: 0x65, info: 0x90, scan: 0x60 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The descriptor and all multi-byte protocol fields are little endian.
export function deviceModel(bytes) {
  const header = [0xa5, 0x5a, 20, 0, 0, 0, 4];
  for (let i = 0; i + 27 <= bytes.length; i++) {
    if (header.every((value, offset) => bytes[i + offset] === value)) return bytes[i + 7];
  }
  return null;
}

export class UsbLidar {
  constructor(serial, onScan, onError, wait = sleep) {
    this.serial = serial;
    this.onError = onError;
    this.wait = wait;
    this.parser = new TminiParser(onScan);
    this.cancelled = false;
    this.info = [];
  }
  checkActive() {
    if (this.cancelled) throw new DOMException('Cancelled', 'AbortError');
  }
  async command(name) {
    if (this.writer) await this.writer.write(Uint8Array.of(0xa5, COMMAND[name]));
  }
  async connect() {
    // Keep requestPort in the originating click's user activation.
    try {
      this.port = await this.serial.requestPort({
        filters: [{ usbVendorId: 0x10c4, usbProductId: 0xea60 }],
      });
      this.checkActive();
      await this.port.open({
        baudRate: 230400,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        bufferSize: 65536,
      });
      this.opened = true;
      this.checkActive();
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
      this.checkActive();
      this.writer = this.port.writable.getWriter();
      this.reader = this.port.readable.getReader();
      this.readTask = this.read();
      await this.wait(BOOT_MS);
      this.checkActive();
      await this.command('stop');
      await this.wait(200);
      let model = null;
      for (let attempt = 0; attempt < 3 && model === null; attempt++) {
        this.checkActive();
        this.info = [];
        this.model = null;
        await this.command('info');
        await this.wait(REPLY_MS);
        model = this.model ?? deviceModel(this.info);
      }
      this.checkActive();
      if (model !== MODEL) throw new Error('wrongModel');
      await this.command('scan');
      this.checkActive();
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async read() {
    try {
      while (!this.cancelled) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) {
          this.info.push(...value);
          const model = this.model ?? deviceModel(this.info);
          if (model === null && this.info.length > 1024) this.info = this.info.slice(-128);
          this.parser.feed(value);
        }
      }
      if (!this.cancelled) this.onError();
    } catch {
      if (!this.cancelled) this.onError();
    } finally {
      this.reader.releaseLock();
      this.reader = null;
    }
  }
  async close() {
    this.cancelled = true;
    if (this.closing) return this.closing;
    this.closing = this.cleanup();
    await this.closing;
    this.closing = null;
  }
  async cleanup() {
    // A chooser/open may still be pending. connect() checks cancellation and closes it later.
    try {
      await this.command('stop');
    } catch {
      /* A removed USB device cannot receive STOP. */
    }
    try {
      await this.reader?.cancel();
      await this.readTask;
    } catch {
      /* Port already removed. */
    }
    this.writer?.releaseLock();
    this.writer = null;
    if (this.opened) {
      try {
        await this.port.setSignals({ dataTerminalReady: true });
      } catch {
        /* Disconnected. */
      }
      try {
        await this.port.close();
      } catch {
        /* Disconnected. */
      }
      this.opened = false;
    }
  }
}
