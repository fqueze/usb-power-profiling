const { usb, getDeviceList } = require('usb');
const HID = require('node-hid');
const http = require('http');
const url = require('url');
const { createDecipheriv } = require('node:crypto');
const { SerialPort } = require('serialport');
const { CRC } = require('crc-full');

const CHARGER_LAB_VENDOR_ID = 0x5FC9;
const FNIRSI_VENDOR_ID = 0x2E3C;
const KINGMETER_VENDOR_ID = 0x416;
const CHARGER_LAB_BLUE_VENDOR_ID = 0x472;
const GENERIC_VENDOR_ID = 0x483;
const SHIZUKU_PRODUCT_IDS = [0xFFFF, 0xFFFE, 0x374B];
const FNIRSI_PRODUCT_IDS = [0x3A, 0x3B];
const KINGMETER_PRODUCT_IDS = [0x5750, 0x5f50];
const WITRN_VENDOR_ID = 0x716;
const RUIDENG_VENDOR_ID = 0x28e9;
const YZXSTUDIO_VENDOR_ID = 0x1a86;

const DEBUG = false;//true;
const DEBUG_log = DEBUG ? console.log : () => {};

const MAX_SAMPLES = 4000000; // About 1.5h at 1kHz.

const gDevices = [];
var startTime, startPerformanceNow;
var gClosing;

function LogSampling() {
  console.log(new Date(), "Sampling...");
}

function roundToNanoSecondPrecision(timeMs) {
  return Math.round(timeMs * 1e6) / 1e6;
}

function int32Bytes(number) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(number);
  return buffer;
}

function resetDevice(device) {
  return new Promise((resolve, reject) => device.reset(error => {
    if (error) {
      console.log("failed to reset device", error);
      reject(error);
    } else {
      resolve();
    }
  }));
}

function sendBuffer(endPointOut, buffer) {
  return new Promise((resolve, reject) => {
    endPointOut.transfer(buffer, err => {
      if (err) {
        console.log("error while sending:", err);
        reject(err);
      }
      resolve();
    });
  });
}

function findBulkInOutEndPoints(device) {
  let endPointIn, endPointOut;
  for (let interface of device.interfaces) {
    let claimed = false;
    for (let endPoint of interface.endpoints) {
      if (endPoint.transferType != usb.LIBUSB_TRANSFER_TYPE_BULK) {
        continue;
      }
      if (endPoint.direction == "in" && !endPointIn) {
        endPointIn = endPoint;
        if (!claimed) {
          claimed = true;
          interface.claim();
        }
      }
      if (endPoint.direction == "out" && !endPointOut) {
        endPointOut = endPoint;
        if (interface.isKernelDriverActive()) {
          try {
            // Only required on linux to be able to claim
            // the interface, otherwise a LIBUSB_ERROR_BUSY error
            // is thrown
            interface.detachKernelDriver();
          } catch (e) {
            // Throws failure on non-linux platforms
          }
        }
        if (!claimed) {
          claimed = true;
          interface.claim();
        }
      }
    }
  }
  return [endPointIn, endPointOut];
}

function addSample(self, time, power) {
  self.sampleTimes.push(time);
  self.samples.push(power);
  if (self.sampleTimes.length > MAX_SAMPLES) {
    self.sampleTimes.shift();
    self.samples.shift();
  }
}

function PowerZDevice(device) {
  this.endPointIn = null;
  this.endPointOut = null;
}

PowerZDevice.prototype = {
  async sample() {
    const CMD_GET_DATA = 0x0C;
    const ATT_ADC = 0x001;
    await sendBuffer(this.endPointOut,
                     Buffer.from([CMD_GET_DATA, 0, ATT_ADC << 1, 0]));

    let data = await new Promise((resolve, reject) => {
      this.endPointIn.transfer(64, (error, data) => {
        if (error) {
          console.log("error reading data", error);
          reject(error);
        }
        resolve(data);
      });
    });

    let v = data.readInt32LE(8);
    let i = data.readInt32LE(12);
    return (v / 1e6) * (i / 1e6);
  },

  async startSampling() {
    try {
      await resetDevice(this.device);
      [this.endPointIn, this.endPointOut] = findBulkInOutEndPoints(this.device);
    } catch(e) {
      console.log(e);
    }

    if (!this.endPointOut || !this.endPointIn) {
      console.log("failed to find endpoints");
      return;
    }

    LogSampling();
    let previousW = 0;
    let w = 0;
    this.interval = setInterval(async () => {
      if (this._promise) {
        return;
      }
      do {
        try {
          this._promise = this.sample();
          w = Math.abs(await this._promise);
          this._promise = null;
          if (gClosing) {
            return;
          }
        } catch(e) {
          if (e.code == "ERR_BUFFER_OUT_OF_BOUNDS") {
            // We sometimes get this error on the first sample when the previous
            // shutdown wasn't clean.
            // The next samples work fine, so just ignore the error.
            continue;
          }
          console.log("aborting sampling", e);
          return this.stopSampling();
        }
      } while (w == previousW);
      previousW = w;
      addSample(this,
                roundToNanoSecondPrecision(performance.now() - startPerformanceNow),
                w);
    }, 1);
  },

  async stopSampling() {
    clearInterval(this.interval);
    if (this._promise) {
      try {
        await this._promise;
      } catch(e) {}
    }
    this.endPointIn = null;
    this.endPointOut = null;
  }
};

function FnirsiDevice(device) {
}

FnirsiDevice.prototype = {
  _crc: new CRC("CRC", 8, 0x39, 0x42),
  checksum(data) { return this._crc.compute(data.slice(1,63)); },

  COMMON_PREFIX: 0xAA,
  // Not sure what this does, things work as well without sending it.
  CMD_INIT: 0x81,
  // Request samples from the device. Every 40ms the device will send a data
  // packet containing 4 samples. Sampling will stop after 1s.
  CMD_START_SAMPLING: 0x82,
  // If sent before the end of the 1s sampling time, this command will make
  // sampling continue for another 1s. Not sure why this command is needed,
  // as just repeatedly sending CMD_START_SAMPLING seems to work just fine.
  CMD_CONTINUE_SAMPLING: 0x83,

  sendCommand(cmd) {
    var outData = new Array(64).fill(0);
    outData[0] = this.COMMON_PREFIX;
    outData[1] = cmd;
    outData[63] = this.checksum(outData);
    return this.hidDevice.write(outData);
  },

  async startSampling() {
    var previousSampleTime = performance.now();
    const {idVendor, idProduct} = this.device.deviceDescriptor;
    this.hidDevice = new HID.HID(idVendor, idProduct);
    this.hidDevice.on('data', data => {
      if (data[0] != this.COMMON_PREFIX || data[1] != 0x04) {
        // ignore when not a data packet.
        return;
      }

      const timeBetweenPackets = 40;
      const samplesPerPacket = 4;
      const intervalBetweenSamples = timeBetweenPackets / samplesPerPacket;
      // The sampling is driven by the device, so it happens at a consistent
      // rate. We sometimes have late packets, adjust the timestamps.
      let now = performance.now();
      const delta = now - previousSampleTime - timeBetweenPackets;
      // Only adjust if the delay is reasonable.
      if (delta > intervalBetweenSamples / 4 &&
          delta < timeBetweenPackets) {
        now -= delta;
      }
      previousSampleTime = now;

      const sampleTime = now - startPerformanceNow;
      if (data[63] != this.checksum(data)) {
        console.log("Invalid CRC:", data[63], "computed:",
                    this.checksum(data));
      }

      for (sampleId = 0; sampleId < samplesPerPacket; ++sampleId) {
        const offset = 2 + 15 * sampleId;
        const voltage = data.readInt32LE(offset) / 1e5;
        const current = data.readInt32LE(offset + 4) / 1e5;
        const timeOffset =
          intervalBetweenSamples * (samplesPerPacket - 1 - sampleId);
        addSample(this, roundToNanoSecondPrecision(sampleTime - timeOffset),
                  voltage * current)
      }
    });
    this.hidDevice.on('error', err => {
      console.log("hid device error:", err);
      clearInterval(this.timerId);
    });

    await this.sendCommand(this.CMD_START_SAMPLING);
    LogSampling();

    this.timerId = setInterval(async () => {
      if (gClosing) {
        return;
      }
      // Could send CMD_CONTINUE_SAMPLING instead, but if somehow we are late
      // and sampling had already stopped, it would be ignored.
      // CMD_START_SAMPLING works in all cases.
      try {
        await this.sendCommand(this.CMD_START_SAMPLING);
      } catch(e) {
        console.log("error sending command:", e);
      }
    }, 500); // Should be at least every second.
  },

  stopSampling() {
    clearInterval(this.timerId);
    this.hidDevice = null;
  }
};

function ShizukuDevice(device) {
  this.endPointIn = null;
  this.endPointOut = null;
  this.lastRequestId = 0;
  this.expectedReplies = {};
}

ShizukuDevice.prototype = {
  samplingInterval: 1, // value in ms.
  BEGIN_DATA: 0xA5,
  END_DATA: 0x5A,
  CMD_STOP: 0x7,
  CMD_START_SAMPLING: 0x9,

  checksum(data) { return data.reduce((acc, curr) => acc ^ curr); },

  async sendCommand(cmd, args = []) {
    const promise = new Promise(resolve => {
      this.expectedReplies[this.lastRequestId] = resolve;
    });
    const COMMON_REQUEST_PREFIX = 0x1;
    const data = [COMMON_REQUEST_PREFIX, cmd, this.lastRequestId++, 0, ...args];
    DEBUG_log("sending command", Buffer.from(data));
    await sendBuffer(this.endPointOut,
                      Buffer.from([this.BEGIN_DATA,
                                   ...int32Bytes(data.length), ...data,
                                   this.checksum(data), this.END_DATA]));
    return promise;
  },

  samplingRequestId: -1,
  initialTimeStamp: 0,
  initialPerformanceNow: 0,
  _pendingData: null,
  ondata(data) {
    if (this._pendingData) {
      DEBUG_log("using _pendingData", this._pendingData, "and new data", data);
      data = Buffer.concat([this._pendingData, data]);
      this._pendingData = null;
    }

    if (data.length < 1 || data[0] != this.BEGIN_DATA) {
      console.log("ignoring a bogus piece of data", data);
      return;
    }

    const minLength =
      1 /* BEGIN_DATA */ + 4 /* 32bit length */ +
      1 /* checksum */ + 1 /* END_DATA */;
    if (data.length < minLength) {
      DEBUG_log("not a full data packet, keeping this piece of data for later", data);
      this._pendingData = data;
      return;
    }

    const length = data.readInt32LE(1);
    if (data.length < minLength + length) {
      DEBUG_log("not a full data packet, keeping this piece of data for later", data);
      this._pendingData = data;
      return;
    }

    const payloadStart = 1 + 4; // 1 for the header, 4 for the 32 bit length
    let payload = data.slice(payloadStart, payloadStart + length);
    if (this.checksum(payload) != data[payloadStart + length]) {
      console.log("invalid checksum, expected:", this.checksum(payload),
                  "got:", data[payloadStart + length],
                  "payload:", payload);
      return;
    }

    let nextData = null;
    if (data.length > minLength + length) {
      nextData = data.slice(minLength + length);
      DEBUG_log("next data", nextData);
    }

    // Check if we received a reply we were waiting for.
    // Unsure about the meaning of the first 2 bytes.
    if (payload.length == 4 &&
        payload[3] == 0x80 && // seems to mean "reply"
        this.expectedReplies.hasOwnProperty(payload[2])) {
      DEBUG_log("got a reply we were waiting for", payload);
      this.expectedReplies[payload[2]]();
      delete this.expectedReplies[payload[2]];
      if (nextData) {
        DEBUG_log("processing next data");
        this.ondata(nextData);
      }
      return;
    }

    // At this point ignore anything that doesn't look like a sample.
    if (payload.length < 4     /* header */ +
                         2 * 4 /* 2 32 bit floats */ +
                         8     /* 64 bit timestamp */ ||
        payload[0] != 0x4 || // Not sure what this means. Maybe 'data' packet?
        payload[1] != 0 ||   // ?? Maybe this was a 16 bit value.
        payload[2] != this.samplingRequestId ||
        payload[3] != 0) { // Seems to be 0x80 for replies and 0 otherwise.
      console.log("ignoring unexpected payload", payload);
      if (nextData) {
        DEBUG_log("processing next data");
        this.ondata(nextData);
      }
      return;
    }

    const sample = payload.slice(4);
    const voltage = sample.readFloatLE();
    const current = Math.abs(sample.readFloatLE(4));
    // Seems to be the time in µs since the power meter was started.
    const timestamp = sample.readBigUInt64LE(sample.length - 8);
    if (!this.initialTimeStamp) {
      this.initialTimeStamp = timestamp;
      this.initialPerformanceNow = performance.now() - startPerformanceNow;
    }
    const time =
      this.initialPerformanceNow + Number(timestamp - this.initialTimeStamp) / 1000;
    const power = Math.round(voltage * current * 1e4) / 1e4;
    DEBUG_log(new Date(), power);
    addSample(this, roundToNanoSecondPrecision(time), power);

    if (nextData) {
      DEBUG_log("processing next data");
      this.ondata(nextData);
    }
  },

  async startSampling() {
    this.deviceName = this.deviceName.replace(/ in Application Mode$/, "");

    try {
      await resetDevice(this.device);
    } catch(e) {
      // resetDevice already logs the error.
    }

    try {
      [this.endPointIn, this.endPointOut] = findBulkInOutEndPoints(this.device);
    } catch(e) {
      console.log(e);
    }

    if (!this.endPointOut || !this.endPointIn) {
      console.log("failed to find endpoints");
      return;
    }

    // When sampling every 1ms, the default of keeping 3 data blocks pending
    // in the kernel is not enough, as it's easy for our thread to be blocked
    // for more than 3ms.
    // 1024 is the maximum and allows us to recover if the main thread was
    // blocked up to about 1.8s.
    this.endPointIn.startPoll(1024);
    this.endPointIn.on('data', data => this.ondata(data))
    this.endPointIn.on('error', err => {
      console.log("Error:", err);
      this.endPointOut = null;
    });

    DEBUG_log("sending CMD_STOP before we start sampling");
    await this.sendCommand(this.CMD_STOP);

    this.samplingRequestId = this.lastRequestId;
    await this.sendCommand(this.CMD_START_SAMPLING,
                           int32Bytes(this.samplingInterval));
    LogSampling();
  },

  async stopSampling() {
    if (!this.endPointOut) {
      if (DEBUG) {
        console.log("already in the process of stopping sampling");
      }
      return;
    }

    DEBUG_log("sending CMD_STOP");
    const stopPromise = this.sendCommand(this.CMD_STOP);
    this.endPointOut = null;
    await stopPromise;

    await new Promise(resolve => this.endPointIn.stopPoll(resolve));
    this.endPointIn = null;
  }
};

function KingMeterDevice(device) {
}

KingMeterDevice.prototype = {
  _crc: CRC.default("CRC16_MODBUS"),
  COMMON_PREFIX: 0x55,

  // The following 4 commands are sent by the original Windows software
  // after finding the device.
  // They don't seem to be needed to get samples, so they are probably used to
  // retrieve data like the firmware version number.
  //   [0x10, 0x02],
  //   [0x10, 0x03],
  //   [0x10, 0x04],
  //   [0x22, 0x80, 0xf1, 0x00],

  // Will get 200 samples on the KingMeter, and only one on Atorch devices.
  CMD_GET_SAMPLES: [0x22, 0x05, 0x0b, 0x00],

  // The name of these commands matches the label of the UI element in the
  // original Windows software. The actual sampling rate they produce doesn't
  // really match, and is indicated in the comments.
  CMD_1000SPS:  [0x31, 0x1a, 0xb1, 0x01, 0x04], // every 2ms
  CMD_100SPS:   [0x31, 0x1a, 0xb1, 0x01, 0x03], // every 10ms
  CMD_50SPS:    [0x31, 0x1a, 0xb1, 0x01, 0x02], // every 20ms
  CMD_10SPS:    [0x31, 0x1a, 0xb1, 0x01, 0x01], // every 100ms
  CMD_1SPS:     [0x31, 0x1a, 0xb1, 0x01, 0x00], // every 100ms

  sendCommand(cmd) {
    // All commands are sent in a 64 buffer. The first byte is always the same,
    // the second byte seems to be the length of the command, then there's a
    // simple checksum on one byte followed by a CRC16.
    var outData = new Array(64).fill(0);
    let i = 0;
    outData[i++] = this.COMMON_PREFIX;
    outData[i++] = cmd.length + 1;
    while (i < cmd.length + 2) {
      outData[i] = cmd[i - 2];
      ++i;
    }
    let array = outData.slice(0, i);
    outData[i++] = array.reduce((a,b) => (a + b) & 0xff);
    if (this.isAtorch) {
      outData[i++] = 0xee;
      outData[i] = 0xff;
    } else {
      let checksum = this._crc.compute(array);
      outData[i++] = checksum & 0xff;
      outData[i] = checksum >> 8;
    }
    return this.hidDevice.write(outData);
  },

  async startSampling() {
    const {idVendor, idProduct} = this.device.deviceDescriptor;
    this.hidDevice = new HID.HID(idVendor, idProduct);
    this.isAtorch = ["ACD15P", "C13P"].some(str => this.deviceName.includes(str));

    this.hidDevice.on('data', data => {
      // Only care about samples.
      if (data[0] != 0xAA || data[1] != (this.isAtorch ? 0x40 : 0x25)) {
        DEBUG_log("got unrecognized data", data.toString('hex'));
        // The KingMeter periodically sends the aa 40 62 05 0b prefix followed
        // by 25 nul bytes, 31 bytes of unknown data and 3 more nul bytes.
        return;
      }

      if (DEBUG) {
        let sample;
        if (this.isAtorch) {
          // First 8 bytes seem constant: aa 40 62 05 0b 00 eb 01
          // Example of the following data:
          //   c6 a6 4f 00  35 0f 01 00  b6 87 05 00  8f 23 00 00  39 16 00 00  cb 2d 0d 00  52 75 32 00  90 d9 b7 01
          //   voltage      current      power        d+           d-           cc1          cc2          temp
          //   e89f87020000900a0000fc714e00010000002a0100000100
          //   Unknown data at bytes 40-64, seems constant or almost constant.
          sample = {
            v: data.readInt32LE(8) / 1e6,
            i: data.readInt32LE(12) / 1e6,
            p: data.readInt32LE(16) / 1e6,
            "d+": data.readInt32LE(20) / 1e6,
            "d-": data.readInt32LE(24) / 1e6,
            "cc1": data.readInt32LE(28) / 1e6,
            "cc2": data.readInt32LE(32) / 1e6,
            temp: data.readInt32LE(36) / 1e6,
            unknown: data.slice(40),
          };
        } else {
          // All data packets seem to start with the same 6 bytes: aa 25 62 05 0b 01
          // Example of the following data:
          //   cd 27 4f 00  1d 21 03 00  0e 7a 0f 00  16 00 00 00  cc 00 00 00  82 27 4f 00  b7 4b 03 00  07 01  01
          //   voltage1     current1     power        d+           d-           voltage2     current2     temp
          //
          // The voltage1/current1 and voltage2/current2 values don't match.
          // There might be an input and output measurement.
          // The power value matches neither v1 * c1 nor v2 * c2, but it is close.
          // The meaning of the value in byte 37 is unknown. It seems to be sometimes
          // 1, 2 or 4. Could be the charging protocol.
          // Bytes 38-63 are always 0.
          // Byte 64 contains another unknown value. It doesn't change enough
          // between samples to feel like a checksum. It is 0x20 most of the time,
          // but sometimes has other values (0, 1, 8, 0x21, 0x40, 0x61).
          sample = {
            v1: data.readInt32LE(6) / 1e6,
            v2: data.readInt32LE(26) / 1e6,
            i1: data.readInt32LE(10) / 1e6,
            i2: data.readInt32LE(30) / 1e6,
            p: data.readInt32LE(14) / 1e6,
            "d+": data.readInt32LE(18) / 1e3,
            "d-": data.readInt32LE(22) / 1e3,
            temp: data.readInt16LE(34) / 10,
            unknown1: data[36],
            unknown2: data[63],
          };
        }
        console.log(sample);
      }

      addSample(this,
                roundToNanoSecondPrecision(performance.now() - startPerformanceNow),
                data.readInt32LE(this.isAtorch ? 16 : 14) / 1e6);
    });
    this.hidDevice.on('error', err => {
      console.log("hid device error:", err);
      clearInterval(this.timerId);
    });

    if (!this.isAtorch) {
      await this.sendCommand(this.CMD_1000SPS);
    }
    await this.sendCommand(this.CMD_GET_SAMPLES);

    LogSampling();
    this.timerId = setInterval(async () => {
      if (gClosing) {
        return;
      }

      try {
        await this.sendCommand(this.CMD_GET_SAMPLES);
      } catch(e) {
        console.log("error sending command:", e);
      }
    }, this.isAtorch ? 1000
                     : 200); // The timer can be longer for slower sampling rates.
  },

  stopSampling() {
    clearInterval(this.timerId);
    this.hidDevice = null;
  }
};

function PowerZBlueDevice(device) {
  // expected product id: 0x2
}

PowerZBlueDevice.prototype = {
  _crc: CRC.default("CRC16_MODBUS"),
  checksum(data) { return this._crc.compute(data.slice(0,62)); },

  async startSampling() {
    const {idVendor, idProduct} = this.device.deviceDescriptor;
    this.hidDevice = new HID.HID(idVendor, idProduct);

    this.hidDevice.on('data', data => {
      if (this.checksum(data) != data.readUInt16LE(62)) {
        console.log(data.toString("hex"),
                    "Invalid CRC:", data.readUInt16LE(62), "computed:",
                    this.checksum(data));
        return;
      }

      if (DEBUG) {
        // First 3 bytes seem to always be [0, 3, 0x3b].
        // Then there are 7 32bit BigEndian floats.
        const sample = {
          v: data.readFloatBE(3),
          i: data.readFloatBE(7),
          p: data.readFloatBE(11),
          "d+": data.readFloatBE(15),
          "d-": data.readFloatBE(19),
          temp1: data.readFloatBE(23),
          temp2: data.readFloatBE(27), // temp2 seems to == temp1
          // The rest is unknown. Example of the unknown data:
          // 01 00 03 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 06 01 00 00 00 00 00 00 28 08
          // The first unknown byte is sometimes 0, sometimes 1.
          // The other bytes don't change from one sample to another.
          unknown: data.slice(31, 62),
        };
        console.log(sample);
      }

      addSample(this,
                roundToNanoSecondPrecision(performance.now() - startPerformanceNow),
                data.readFloatBE(11));
    });
    this.hidDevice.on('error', err => {
      console.log("hid device error:", err);
    });
    LogSampling();
  },

  stopSampling() {
    this.hidDevice = null;
  }
};

function findVoltageOffset(data) {
  var candidates = [
    [offset => data.readInt32LE(offset) / 1e6, "Int32LE / 1e6"],
    [offset => data.readInt32LE(offset) / 1e5, "Int32LE / 1e5"],
    [offset => data.readInt32LE(offset) / 1e4, "Int32LE / 1e4"],
    [offset => data.readInt32BE(offset) / 1e6, "Int32BE / 1e6"],
    [offset => data.readInt32BE(offset) / 1e5, "Int32BE / 1e5"],
    [offset => data.readInt32BE(offset) / 1e4, "Int32BE / 1e4"],
    [offset => data.readFloatLE(offset), "FloatLE"],
    [offset => data.readFloatBE(offset), "FloatBE"],
  ];
  for (let offset = 0; offset < data.length - 4; ++offset) {
    for (let [fun, desc] of candidates) {
      let val = fun(offset);
      if (val > 5 && val < 5.5) {
        console.log("Offset:", offset, val, desc);
      }
    }
  }
}

function WitrnDevice(device) {
}

WitrnDevice.prototype = {
  async startSampling() {
    const {idVendor, idProduct} = this.device.deviceDescriptor;
    this.hidDevice = new HID.HID(idVendor, idProduct);

    let initialTimeStamp = 0, initialPerformanceNow = 0;
    let timestampWrapArounds = 0;
    let lastTime_s = 0;
    this.hidDevice.on('data', data => {
      if (data[0] != 0xff || data[1] != 0x55) {
        // All the data packets seem to start with 0xff 0x55.
        DEBUG_log("ignoring unexpected packet", data[0], data[1]);
        return;
      }

      const sum = array => array.reduce((acc, val) => acc + val);
      const payloadChecksum = sum(data.slice(8, 62)) % 256;
      const packetChecksum = (sum(data.slice(0, 8)) + payloadChecksum) % 256;
      if (data[data.length - 2] != payloadChecksum ||
          data[data.length - 1] != packetChecksum) {
        console.log(data.toString("hex"),
                    "Invalid checksums:", [data[data.length - 2], data[data.length - 1]],
                    "computed:", [payloadChecksum, packetChecksum]);
        return;
      }

      const v = data.readFloatLE(46);
      const i = data.readFloatLE(50);

      const time_s = data[2];  // time in seconds, on a single byte (ie. % 256)
      const time_ms = data[3]; // time in ms, on a single byte (ie. % 256)
      // data[4]: time_ms / 30
      // data[5]: time_ms / 100
      const time_ms_mod100 = data[6]; // time in ms, % 100
      // data[7]: time_ms / 80
      if (time_s < 10 && lastTime_s > 250) {
        ++timestampWrapArounds;
      }
      const timestamp =
        (time_s + timestampWrapArounds * 256) * 1000 +
        [0, 1, 2, 3].map(i =>  (256 * i + time_ms) % 1000).find(ms => ms % 100 == time_ms_mod100);
      lastTime_s = time_s;

      if (DEBUG) {
        const sample = {
          timestamp,
          v,
          i,
          "d-": data.readFloatLE(34),
          "d+": data.readFloatLE(30),
          time: data.readUInt32LE(26),    // time in seconds since the meter started.
          rectime: data.readUInt32LE(22), // time in seconds displayed as 'rec' on the device
          wh: data.readFloatLE(18),
          ah: data.readFloatLE(14),
          unknown1: data.slice(10, 14),   // Very stable, or even constant.
          unknown2: data.readFloatLE(38), // Always 25
          unknown3: data.readFloatLE(42), // -73.<something that changes all the time>
        };
        console.log(sample);
      }

      if (!initialTimeStamp) {
        initialTimeStamp = timestamp;
        initialPerformanceNow = performance.now() - startPerformanceNow;
      }
      const time =
        initialPerformanceNow + Number(timestamp - initialTimeStamp);
      addSample(this, roundToNanoSecondPrecision(time), v * i);
    });
    this.hidDevice.on('error', err => {
      console.log("hid device error:", err);
    });
    LogSampling();
  },

  stopSampling() {
    this.hidDevice = null;
  }
};

function RuiDengDevice(device) {
}

RuiDengDevice.prototype = {
  _crc: CRC.default("CRC16_MODBUS"),
  checksum(data) { return this._crc.compute(data.slice(0,60)); },
  _key: Buffer.from([
        88, 33, -6, 86, 1, -78, -16, 38,
        -121, -1, 18, 4, 98, 42, 79, -80,
        -122, -12, 2, 96, -127, 111, -102, 11,
        -89, -15, 6, 97, -102, -72, 114, -120
  ]),
  requestSample() {
    this._lastSampleRequestTime = Date.now();
    this.serialDevice.write("getva");
  },
  ondata(data) {
    let buf = this.decipher.update(data);
    if (buf.length < 64) {
      console.log("received data is too short", buf.length, buf);
      return;
    }

    if (this.checksum(buf) != buf.readUInt32LE(60)) {
      console.log(buf.toString("hex"),
                  "Invalid CRC:", buf.readUInt32LE(60), "computed:",
                  this.checksum(buf));
      return;
    }

    let prefix = buf.slice(0, 4).toString('ascii');
    if (prefix == 'pac1') {
      let power = buf.readUInt32LE(56) * 1e-4;
      addSample(this,
                roundToNanoSecondPrecision(performance.now() - startPerformanceNow),
                power);
      if (DEBUG) {
        let sample = {
          productName: buf.slice(4, 8).toString('ascii'),
          version: buf.slice(8, 12).toString('ascii'),
          serialNumber: buf.readUInt32LE(12),
          unknown: buf.slice(16, 44),
          sessionCount: buf.readUInt32LE(44),
          voltage: buf.readUInt32LE(48) * 1e-4,
          current: buf.readUInt32LE(52) * 1e-5,
          power
        };
        console.log(sample);
      }
    } else if (prefix == 'pac2') {
      if (DEBUG) {
        let sample = {
          temperature: buf.readUInt32LE(28),
          resistance: buf.readUInt32LE(4) * 1e-1,
          'd+': buf.readUInt32LE(32) * 1e-2,
          'd-': buf.readUInt32LE(36) * 1e-2,
        };
        if (buf.readUInt32LE(28) == 1) {
          sample.temperature *= -1;
        }
        console.log(sample);
      }
    } else if (prefix == 'pac3') {
      if (DEBUG) {
        // Always 0, print debug message if a non-zero value is present.
        let allZero = true;
        for (let i = 4; i < 60; ++i) {
          if (buf[i] != 0) {
            console.log("pac3 was expected to be all zero, but found data:",
                        buf.slice(4, 60).toString('hex'));
            break;
          }
        }
      }
      this.requestSample();
    } else {
      console.log("unknown data packet:", buf.toString('hex'));
    }
  },
  async startSampling() {
    let serialDevices = (await SerialPort.list()).filter(d => d.manufacturer == "RuiDeng");
    if (!serialDevices.length) {
      console.log("serial device not found");
      return;
    }
    DEBUG_log("Found serial devices", serialDevices);
    this.decipher = createDecipheriv("AES-256-ECB", this._key, null);
    this.decipher.setAutoPadding(false);
    this.serialDevice = new SerialPort({path: serialDevices[0].path, baudRate: 115200});
    await new Promise((resolve, reject) => this.serialDevice.on("open", err => {
      if (err) {
        reject("error opening serial port:" + err);
      } else {
        resolve();
      }
    }));

    this.serialDevice.flush(); // discard pending data
    this.serialDevice.on("error", console.log);
    this.serialDevice.on("data", data => { this.ondata(data); });

    this.requestSample();
    this.interval = setInterval(() => {
      let lastSampleAge = Date.now() - this._lastSampleRequestTime;
      if (lastSampleAge > 200) {
        DEBUG_log("The last sample is too old (" + lastSampleAge +
                  "ms), restarting sampling.");
        this.requestSample();
      }
    }, 100);
    LogSampling();
  },

  stopSampling() {
    clearInterval(this.interval);
    this.decipher = null;
    this.serialDevice.close();
    this.serialDevice = null;
  }
};

function YzxStudioDevice(device) {
}

YzxStudioDevice.prototype = {
  ondata(data) {
    if (data.length < 28) {
      console.log("received data is too short", data.length, data);
      return;
    }

    if (data[0] != 0xAB) {
      console.log("incorrect first byte", data[0]);
      return;
    }

    const sum = array => array.reduce((acc, val) => acc + val);
    const checksum = sum(data.slice(0, 27)) % 256;
    if (checksum != data[27]) {
      console.log(data.toString("hex"),
                  "Invalid checksum:", data[27], "computed:", checksum);
      return;
    }

    let v = data.readInt32LE(3) * 1e-4;
    let i = data.readUInt32LE(7) * 1e-4;
    if (DEBUG) {
      let sample = {
        v, i,
        Ah: data.readUInt32LE(11) * 1e-4,
        Wh: data.readUInt32LE(15) * 1e-4,
        // The T_ms value is changing in 250ms increment, but it only moves when
        // the power is > 0, making it unsuitable for our sample times.
        T_ms: data.readUInt32LE(19) * 1e1,
        "d+": data.readUInt16LE(23) * 1e-3,
        "d-": data.readUInt16LE(25) * 1e-3,
      };
      console.log(sample, "power", data.readInt32LE(3) * 1e-4 * data.readUInt32LE(7) * 1e-4);
    }

    addSample(this, roundToNanoSecondPrecision(performance.now() - startPerformanceNow), v * i);
  },
  async startSampling() {
    this.deviceName = "YZXStudio";

    let serialDevices = (await SerialPort.list()).filter(d => d.vendorId == "1a86");
    if (!serialDevices.length) {
      console.log("serial device not found");
      return;
    }
    DEBUG_log("Found serial devices", serialDevices);
    this.serialDevice = new SerialPort({path: serialDevices[0].path, baudRate: 115200});
    await new Promise((resolve, reject) => this.serialDevice.on("open", err => {
      if (err) {
        reject("error opening serial port:" + err);
      } else {
        resolve();
      }
    }));

    this.serialDevice.flush(); // discard pending data
    this.serialDevice.on("error", console.log);
    this.serialDevice.on("data", data => { this.ondata(data); });
    LogSampling();
  },

  stopSampling() {
    this.serialDevice.close();
    this.serialDevice = null;
  }
};

const SUPPORTED_DEVICES = {}
SUPPORTED_DEVICES[CHARGER_LAB_VENDOR_ID] = PowerZDevice;
SUPPORTED_DEVICES[FNIRSI_VENDOR_ID] = FnirsiDevice;
SUPPORTED_DEVICES[KINGMETER_VENDOR_ID] = KingMeterDevice;
SUPPORTED_DEVICES[CHARGER_LAB_BLUE_VENDOR_ID] = PowerZBlueDevice;
SUPPORTED_DEVICES[WITRN_VENDOR_ID] = WitrnDevice;
SUPPORTED_DEVICES[RUIDENG_VENDOR_ID] = RuiDengDevice;
SUPPORTED_DEVICES[YZXSTUDIO_VENDOR_ID] = YzxStudioDevice;

async function getDeviceName(device) {
  let manufacturer = await new Promise((resolve, reject) => {
    device.getStringDescriptor(device.deviceDescriptor.iManufacturer, (err, manufacturer) => {
      if (err) {
        reject();
      } else {
        resolve(manufacturer);
      }
    })
  });

  return new Promise((resolve, reject) => {
    device.getStringDescriptor(device.deviceDescriptor.iProduct, (err, productName) => {
      if (!err && productName) {
        resolve(`${manufacturer} — ${productName}`);
      } else {
        reject();
      }
    });
  });
}

async function getDeviceSerialNumber(device) {
  return new Promise((resolve, reject) => {
    device.getStringDescriptor(device.deviceDescriptor.iSerialNumber, (err, number) => {
      if (err) {
        reject();
      } else {
        resolve(number);
      }
    })
  });
}

async function tryDevice(device) {
  const {idVendor, idProduct} = device.deviceDescriptor;
  let dev;
  if (idVendor == GENERIC_VENDOR_ID) {
    if (SHIZUKU_PRODUCT_IDS.includes(idProduct)) {
      dev = new ShizukuDevice(device);
    } else if (FNIRSI_PRODUCT_IDS.includes(idProduct)) {
      dev = new FnirsiDevice(device);
    } else if (KINGMETER_PRODUCT_IDS.includes(idProduct)) {
      dev = new KingMeterDevice(device);
    }
  } else if (idVendor in SUPPORTED_DEVICES) {
    dev = new SUPPORTED_DEVICES[idVendor](device);
  }

  if (dev) {
    try {
      device.open();
      dev.deviceName = await getDeviceName(device);
      dev.serialNumber = await getDeviceSerialNumber(device);
      console.log(new Date(),
                  "Found device:", dev.deviceName,
                  "Serial Number:", dev.serialNumber,
                  "Vendor Id: 0x" + idVendor.toString(16),
                  "Product Id: 0x" + idProduct.toString(16),
                  `Address: ${device.busNumber}:${device.deviceAddress}`);
      const envSerialNumber = process.env.USB_POWER_METER_SERIAL_NUMBER;
      if (envSerialNumber && dev.serialNumber != envSerialNumber) {
        console.log("Not sampling this power meter as its serial number is not " +
                    envSerialNumber);
        return;
      }
      dev.device = device;

      let existingDeviceIndex =
        gDevices.findIndex(d => dev.serialNumber == d.serialNumber &&
                           idVendor == d.device.deviceDescriptor.idVendor &&
                           idProduct == d.device.deviceDescriptor.idProduct);
      if (existingDeviceIndex != -1) {
        let existingDev = gDevices[existingDeviceIndex];
        dev.samples = existingDev.samples;
        dev.sampleTimes = existingDev.sampleTimes;
        gDevices[existingDeviceIndex] = dev;
      } else {
        dev.samples = [];
        dev.sampleTimes = [];
        gDevices.push(dev);
      }

      await dev.startSampling();
    } catch(e) {
      console.log(e);
    }
  } else if (DEBUG) {
    try {
      device.open();
      console.log(new Date(),
                  "found unknown device:", await getDeviceName(device),
                  "Serial Number:", await getDeviceSerialNumber(device),
                  "Vendor Id: 0x" + idVendor.toString(16),
                  "Product Id: 0x" + idProduct.toString(16),
                  device);
      device.close();
    } catch(e) { console.log(e); }
  }
}

async function startSampling() {
  initialize();

  startTime = Date.now();
  startPerformanceNow = performance.now();

  const devices = getDeviceList();
  for (let device of devices) {
    await tryDevice(device);
  }
  if (gDevices.length == 0) {
    console.log("No device found")
  }
}

var initialized = false;

function initialize() {
  if (initialized) {
    return;
  }

  process.on('SIGINT', async function() {
    if (gClosing) {
      return;
    }
    gClosing = true;
    if (gDevices.length > 0) {
      await Promise.all(gDevices.map(d => d.stopSampling()));
    }
    process.exit();
  });

  usb.on('attach', device => {
    console.log(new Date(), "Device attached");
    tryDevice(device);
  });
  usb.on('detach', function(device) {
    if (!(device.deviceDescriptor.idVendor in SUPPORTED_DEVICES)) {
      return;
    }

    if (!gDevices.length) {
      return;
    }

    const dev = gDevices.find(d => device.busNumber == d.device.busNumber && device.deviceAddress == d.device.deviceAddress);
    if (dev) {
      console.log(dev.deviceName, "has been detached");
      dev.device.close();
      dev.device = null;
      gDevices.splice(gDevices.indexOf(dev), 1);
    } else {
      console.log("detach", device);
    }
  });

  initialized = true;
}


function sendJSON(res, data, forceGC = false) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  let json = JSON.stringify(data);
  if (forceGC && global.gc) {
    data = null;
    global.gc();
  }
  res.end(json);
}

function sendError(res, error) {
  res.statusCode = 500;
  res.setHeader('Content-Type', 'text/plain');
  res.end(error + '\n');
  console.log(error);
}

const baseProfile = '{"meta":{"interval":1,"startTime":0,"abi":"","misc":"","oscpu":"","platform":"","processType":0,"extensions":{"id":[],"name":[],"baseURL":[],"length":0},"categories":[{"name":"Other","color":"grey","subcategories":["Other"]}],"product":"Home power profiling","stackwalk":0,"toolkit":"","version":27,"preprocessedProfileVersion":48,"appBuildID":"","sourceURL":"","physicalCPUs":0,"logicalCPUs":0,"CPUName":"","symbolicationNotSupported":true,"markerSchema":[]},"libs":[],"pages":[],"threads":[{"processType":"default","processStartupTime":0,"processShutdownTime":null,"registerTime":0,"unregisterTime":null,"pausedRanges":[],"name":"GeckoMain","isMainThread":true,"pid":"0","tid":0,"samples":{"weightType":"samples","weight":null,"eventDelay":[],"stack":[],"time":[],"length":0},"markers":{"data":[],"name":[],"startTime":[],"endTime":[],"phase":[],"category":[],"length":0},"stackTable":{"frame":[0],"prefix":[null],"category":[0],"subcategory":[0],"length":1},"frameTable":{"address":[-1],"inlineDepth":[0],"category":[null],"subcategory":[0],"func":[0],"nativeSymbol":[null],"innerWindowID":[0],"implementation":[null],"line":[null],"column":[null],"length":1},"funcTable":{"isJS":[false],"relevantForJS":[false],"name":[0],"resource":[-1],"fileName":[null],"lineNumber":[null],"columnNumber":[null],"length":1},"resourceTable":{"lib":[],"name":[],"host":[],"type":[],"length":0},"nativeSymbols":{"libIndex":[],"address":[],"name":[],"functionSize":[],"length":0}}],"counters":[]}';

function WattSecondToPicoWattHour(value) {
  return value / 3600 * 1e12;
}

function counterObject(name, description, times, samples, geckoFormat = false) {
  let time = [];
  // Remove consecutive 0 samples.
  let count = samples.filter((sample, index) => {
    let keep =
      sample != 0 ||
      index == 0 || index == samples.length - 1 ||
      samples[index - 1] != 0 || samples[index + 1] != 0;
    if (keep) {
      time.push(times[index])
    }
    return keep;
  });

  let rv = {
    name,
    category: "power",
    description,
  };

  if (geckoFormat) {
    let data = [];
    for (let i = 0; i < time.length; ++i) {
      data.push([time[i], count[i]]);
    }
    rv.samples = {
      schema: {time:0, count:1},
      data
    };
  } else {
    rv.pid = "0";
    rv.mainThreadIndex = 0;
    rv.samples = {
      time, count, length: count.length
    };
  }
  return rv;
}

function profileFromData() {
  if (!gDevices.length) {
    throw "No device is being sampled";
  }

  let profile = JSON.parse(baseProfile);
  profile.meta.startTime = startTime;
  profile.meta.product = new Date(startTime).toLocaleDateString("fr-FR", {timeZone: "Europe/Paris"}) + " — USB power";
  profile.meta.physicalCPUs = 1;
  profile.meta.CPUName = gDevices.map(d => `${d.deviceName} (${d.serialNumber})`).join(", ");

  const threadSampleTimes = [].concat(...gDevices.map(dev => dev.sampleTimes));
  threadSampleTimes.sort((a, b) => a - b);
  let zeros = new Array(threadSampleTimes.length).fill(0);
  let firstThread = profile.threads[0];
  let threadSamples = firstThread.samples;
  threadSamples.eventDelay = zeros;
  threadSamples.stack = zeros;
  threadSamples.time = threadSampleTimes;
  threadSamples.length = threadSampleTimes.length;

  firstThread.stringArray = ["(root)"];

  for (let dev of gDevices) {
    let {deviceName, sampleTimes} = dev;
    let timeInterval = i => i == 0 ? 1 : (sampleTimes[i] - sampleTimes[i - 1]) / 1000;
    let samples = [];
    for (let i = 0; i < sampleTimes.length; ++i) {
      let sample = dev.samples[i];
      let interval = timeInterval(i);
      samples.push(Math.max(0, Math.round(WattSecondToPicoWattHour(sample) * interval)));
    }
    if (!samples.some(s => s > 0)) {
      continue;
    }
    profile.counters.push(counterObject("USB power", deviceName, sampleTimes, samples));
  }

  return profile;
}

function getPowerData(start, end) {
  let timeStart = parseFloat(start) - startTime;
  let timeEnd = parseFloat(end) - startTime;
  if (timeEnd < 0) {
    throw "The requested end time is before this instance of the script was started."
  }

  let counters = [];
  for (let device of gDevices) {
    const {samples, sampleTimes, deviceName} = device;

    let startIndex = 0;
    while (sampleTimes[startIndex] < timeStart) {
      ++startIndex;
    }

    let endIndex = startIndex;
    while (sampleTimes[endIndex] <= timeEnd) {
      ++endIndex;
    }

    let times = sampleTimes.slice(startIndex, endIndex).map(t => roundToNanoSecondPrecision(t - timeStart));
    let timeInterval = i => i == 0 ? 1 : (times[i] - times[i - 1]) / 1000;
    let counter = counterObject("USB power", deviceName, times,
                                samples.slice(startIndex, endIndex)
                                       .map((sample, i) => Math.round(WattSecondToPicoWattHour(sample) * timeInterval(i))), true);
  
    counters.push(counter);
  }

  return counters;
}

function resetPowerData() {
  for (let device of gDevices) {
    device.samples = [];
    device.sampleTimes = [];
  }
}

const app = (req, res) => {
  console.log(new Date(), req.url);

  if (req.url.startsWith("/power")) {
    if (!gDevices.length) {
      sendError(res, "power: no device is being sampled");
      return;
    }

    const query = url.parse(req.url, true).query;
    if (!query.start && !query.end) {
      sendError(res, "power: The /power API requires sppecifying start and end timestamps,"
                + " see https://github.com/fqueze/usb-power-profiling/tree/main#http-api");
      return;
    }

    let timeEnd = parseFloat(query.end) - startTime;
    if (timeEnd < 0) {
      sendError(res, "power: The requested end time is before this instance of the script was started.");
      return;
    }

    sendJSON(res, getPowerData(query.start, query.end), true);
    return;
  }

  if (req.url.startsWith("/profile")) {
    try {
      sendJSON(res, profileFromData(), true);
    } catch (err) {
      sendError(res, 'profile: ' + err);
    }
    return;
  }

  // This is for debugging USB error recovery: GET /wait?time=200 blocks the
  // main thread for 200ms, during which no USB data is processed.
  if (req.url.startsWith("/wait")) {
    const waitTime = url.parse(req.url, true).query.time || 500;
    let startTime = Date.now();
    while (Date.now() - startTime < waitTime)
      ;
    sendError(res, 'wait: ' + (Date.now() - startTime));
    return;
  }

  if (req.url == "/reset") {
    resetPowerData();
    res.end('Power data reset');
    return;
  }
};

var server;

async function runPowerCollectionServer(customPort) {
  await startSampling();

  const port = customPort || process.env.PORT || 2121;
  server = http.createServer(app)
  server.listen(port, "0.0.0.0", () => {
    console.log(`Ensure devtools.performance.recording.power.external-url is set to http://localhost:${port}/power in 'about:config'.`);
  });
}

if (require.main === module) {
  startSampling().then(() => {
    runPowerCollectionServer();
  });
}

module.exports = {
  startSampling,
  getPowerData,
  resetPowerData,
  profileFromData
}
