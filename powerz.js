const { usb, getDeviceList } = require('usb');
const HID = require('node-hid');
const http = require('http');
const url = require('url');
const { CRC } = require('crc-full');

const CHARGER_LAB_VENDOR_ID = 0x5FC9;
const FNIRSI_VENDOR_ID = 0x2E3C;
const KINGMETER_VENDOR_ID = 0x416;
const GENERIC_VENDOR_ID = 0x483;
const SHIZUKU_PRODUCT_IDS = [0xFFFF, 0xFFE, 0x374B];
const FNIRSI_PRODUCT_IDS = [0x3A, 0x3B];
const KINGMETER_PRODUCT_IDS = [0x5750, 0x5f50];

const DEBUG = false;//true;
const DEBUG_log = DEBUG ? console.log : () => {};

const MAX_SAMPLES = 4000000; // About 1.5h at 1kHz.

const gDevices = [];
var startTime, startPerformanceNow;
var gClosing;

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

    console.log("Sampling...");
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
    console.log("Sampling...");

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
  initialNow: 0,
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

    // When sampling every 1ms, the default of keeping 3 data blocks pending
    // in the kernel is not enough, as it's easy for our thread to be blocked
    // for more than 3ms.
    this.endPointIn.startPoll(150);
    this.endPointIn.on('data', data => this.ondata(data))
    this.endPointIn.on('error', err => {
      console.log("Error:", err);
    });

    DEBUG_log("sending CMD_STOP before we start sampling");
    await this.sendCommand(this.CMD_STOP);

    this.samplingRequestId = this.lastRequestId;
    await this.sendCommand(this.CMD_START_SAMPLING,
                           int32Bytes(this.samplingInterval));
    console.log("Sampling...");
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
  COMMON_PREFIX: 0x55,

  // The following 4 commands are sent by the original Windows software
  // after finding the device.
  // They don't seem to be needed to get samples, so they are probably used to
  // retrieve data like the firmware version number.
  //   [0x10, 0x02, 0x6a, 0x6d, 0xe9],
  //   [0x10, 0x03, 0x6b, 0xac, 0x29],
  //   [0x10, 0x04, 0x6c, 0xed, 0xeb],
  //   [0x22, 0x80, 0xf1, 0x00, 0xed, 0x8e, 0x1e],

  CMD_GET_200_SAMPLES: [0x22, 0x05, 0x0b, 0x00, 0x8c, 0xdd, 0x57],

  // The name of these commands matches the label of the UI element in the
  // original Windows software. The actual sampling rate they produce doesn't
  // really match, and is indicated in the comments.
  CMD_1000SPS:  [0x31, 0x1a, 0xb1, 0x01, 0x04, 0x5c, 0x34, 0xcb], // every 2ms
  CMD_100SPS:   [0x31, 0x1a, 0xb1, 0x01, 0x03, 0x5b, 0x75, 0x09], // every 10ms
  CMD_50SPS:    [0x31, 0x1a, 0xb1, 0x01, 0x02, 0x5a, 0xb4, 0xc9], // every 20ms
  CMD_10SPS:    [0x31, 0x1a, 0xb1, 0x01, 0x01, 0x59, 0xf4, 0xc8], // every 100ms
  CMD_1SPS:     [0x31, 0x1a, 0xb1, 0x01, 0x00, 0x58, 0x35, 0x08], // every 100ms

  sendCommand(cmd) {
    // All commands are sent in a 64 buffer. The first byte is always the same,
    // the second byte seems to be the length of the command, and it is likely
    // that the last 2 bytes are some form of checksum. I haven't identified
    // the checksum algorithm, so the command arrays include the checksums.
    var outData = new Array(64).fill(0);
    outData[0] = this.COMMON_PREFIX;
    outData[1] = cmd.length - 2;
    for (let i = 0; i < cmd.length; ++i) {
      outData[i + 2] = cmd[i];
    }
    return this.hidDevice.write(outData);
  },

  async startSampling() {
    const {idVendor, idProduct} = this.device.deviceDescriptor;
    this.hidDevice = new HID.HID(idVendor, idProduct);

    this.hidDevice.on('data', data => {
      // Only care about samples.
      if (data[0] != 0xAA || data[1] != 0x25) {
        return;
      }

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
      if (DEBUG) {
        const sample = {
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
        console.log(sample);
      }

      addSample(this,
                roundToNanoSecondPrecision(performance.now() - startPerformanceNow),
                data.readInt32LE(14) / 1e6);
    });
    this.hidDevice.on('error', err => {
      console.log("hid device error:", err);
      clearInterval(this.timerId);
    });

    await this.sendCommand(this.CMD_1000SPS);

    console.log("Sampling...");
    this.timerId = setInterval(async () => {
      if (gClosing) {
        return;
      }

      try {
        await this.sendCommand(this.CMD_GET_200_SAMPLES);
      } catch(e) {
        console.log("error sending command:", e);
      }
    }, 200); // The timer can be longer for slower sampling rates.
  },

  stopSampling() {
    clearInterval(this.timerId);
    this.hidDevice = null;
  }
};

const SUPPORTED_DEVICES = {}
SUPPORTED_DEVICES[CHARGER_LAB_VENDOR_ID] = PowerZDevice;
SUPPORTED_DEVICES[FNIRSI_VENDOR_ID] = FnirsiDevice;
SUPPORTED_DEVICES[KINGMETER_VENDOR_ID] = KingMeterDevice;

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

async function tryDevice(device) {
  const vendorId = device.deviceDescriptor.idVendor;
  let dev;
  if (vendorId == GENERIC_VENDOR_ID) {
    const productId = device.deviceDescriptor.idProduct;
    if (SHIZUKU_PRODUCT_IDS.includes(productId)) {
      dev = new ShizukuDevice(device);
    } else if (FNIRSI_PRODUCT_IDS.includes(productId)) {
      dev = new FnirsiDevice(device);
    } else if (KINGMETER_PRODUCT_IDS.includes(productId)) {
      dev = new KingMeterDevice(device);
    }
  } else if (vendorId in SUPPORTED_DEVICES) {
    dev = new SUPPORTED_DEVICES[vendorId](device);
  }

  if (dev) {
    try {
      device.open();
      dev.deviceName = await getDeviceName(device);
      console.log("Found device:", dev.deviceName);
      dev.device = device;
      dev.samples = [];
      dev.sampleTimes = [];
      await dev.startSampling();
      gDevices.push(dev);
    } catch(e) {
      console.log(e);
    }
  } else if (DEBUG) {
    try {
      device.open();
      console.log("found unknown device:", await getDeviceName(device), device);
      device.close();
    } catch(e) { console.log(e); }
  }
}

async function startSampling() {
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

startSampling().then(() => {});

usb.on('attach', tryDevice);
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

const baseProfile = '{"meta":{"interval":1,"startTime":0,"abi":"","misc":"","oscpu":"","platform":"","processType":0,"extensions":{"id":[],"name":[],"baseURL":[],"length":0},"categories":[{"name":"Other","color":"grey","subcategories":["Other"]}],"product":"Home power profiling","stackwalk":0,"toolkit":"","version":27,"preprocessedProfileVersion":47,"appBuildID":"","sourceURL":"","physicalCPUs":0,"logicalCPUs":0,"CPUName":"","symbolicationNotSupported":true,"markerSchema":[]},"libs":[],"pages":[],"threads":[{"processType":"default","processStartupTime":0,"processShutdownTime":null,"registerTime":0,"unregisterTime":null,"pausedRanges":[],"name":"GeckoMain","isMainThread":true,"pid":"0","tid":0,"samples":{"weightType":"samples","weight":null,"eventDelay":[],"stack":[],"time":[],"length":0},"markers":{"data":[],"name":[],"startTime":[],"endTime":[],"phase":[],"category":[],"length":0},"stackTable":{"frame":[0],"prefix":[null],"category":[0],"subcategory":[0],"length":1},"frameTable":{"address":[-1],"inlineDepth":[0],"category":[null],"subcategory":[0],"func":[0],"nativeSymbol":[null],"innerWindowID":[0],"implementation":[null],"line":[null],"column":[null],"length":1},"funcTable":{"isJS":[false],"relevantForJS":[false],"name":[0],"resource":[-1],"fileName":[null],"lineNumber":[null],"columnNumber":[null],"length":1},"resourceTable":{"lib":[],"name":[],"host":[],"type":[],"length":0},"nativeSymbols":{"libIndex":[],"address":[],"name":[],"functionSize":[],"length":0}}],"counters":[]}';

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
    rv.sample_groups = [
      {
        id:0,
        samples: {
          schema: {time:0, count:1},
          data
        }
      }
    ];
  } else {
    rv.pid = "0";
    rv.mainThreadIndex = 0;
    rv.sampleGroups = [
      {
        id: 0,
        samples: {
          time, count, length: count.length
        }
      }
    ];
  }
  return rv;
}

function profileFromData() {
  if (!gDevices.length) {
    throw "No device is being sampled";
  }
  const dev = gDevices[0]; //TODO: include data for all devices

  let profile = JSON.parse(baseProfile);
  profile.meta.startTime = startTime;
  profile.meta.product = new Date(startTime).toLocaleDateString("fr-FR", {timeZone: "Europe/Paris"}) + " — USB power";
  profile.meta.physicalCPUs = 1;
  profile.meta.CPUName = gDevices.map(d => d.deviceName).join(", ");

  const sampleTimes = dev.sampleTimes;
  let zeros = new Array(sampleTimes.length).fill(0);
  let firstThread = profile.threads[0];
  let threadSamples = firstThread.samples;
  threadSamples.eventDelay = zeros;
  threadSamples.stack = zeros;
  threadSamples.time = sampleTimes;
  threadSamples.length = sampleTimes.length;

  firstThread.stringArray = ["(root)"];

  const counters = [
    {
      name: "USB power",
      description: dev.deviceName,
      fun: i => dev.samples[i],
    },
  ];

  let timeInterval = i => i == 0 ? 1 : (sampleTimes[i] - sampleTimes[i - 1]) / 1000;
  for (let {name, description, fun} of counters) {
    let samples = [];
    for (let i = 0; i < sampleTimes.length; ++i) {
      let sample = fun(i);
      let interval = timeInterval(i);
      samples.push(Math.max(0, Math.round(WattSecondToPicoWattHour(sample) * interval)));
    }
    if (!samples.some(s => s > 0)) {
      continue;
    }
    profile.counters.push(counterObject(name, description, sampleTimes, samples));
  }

  return profile;
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
      sendError(res, "power: unexpected case");
      return;
    }

    //TODO: include data for all devices
    const {samples, sampleTimes, deviceName} = gDevices[0];

    let timeStart = parseFloat(query.start) - startTime;
    let startIndex = 0;
    while (sampleTimes[startIndex] < timeStart) {
      ++startIndex;
    }

    let timeEnd = parseFloat(query.end) - startTime;
    let endIndex = startIndex;
    while (sampleTimes[endIndex] <= timeEnd) {
      ++endIndex;
    }

    let times = sampleTimes.slice(startIndex, endIndex).map(t => roundToNanoSecondPrecision(t - timeStart));
    let timeInterval = i => i == 0 ? 1 : (times[i] - times[i - 1]) / 1000;
    let counter = counterObject("USB power", deviceName, times,
                                samples.slice(startIndex, endIndex)
                                       .map((sample, i) => Math.round(WattSecondToPicoWattHour(sample) * timeInterval(i))), true);
    sendJSON(res, [counter], true);
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
};

const server = http.createServer(app)
server.listen(2121, "0.0.0.0", () => {
  console.log("Ensure devtools.performance.recording.power.external-url is set to http://localhost:2121/power in 'about:config'.");
});
