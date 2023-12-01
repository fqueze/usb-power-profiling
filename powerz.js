const { usb, getDeviceList } = require('usb');
const http = require('http');
const url = require('url');

const CHARGER_LAB_VENDOR_ID = 0x5FC9;
const MAX_SAMPLES = 4000000; // About 1.5h at 1kHz.

const gDevices = [];
var startTime, startPerformanceNow;
var gClosing;

function roundToNanoSecondPrecision(timeMs) {
  return Math.round(timeMs * 1e6) / 1e6;
}

function PowerZDevice(device) {
  this.device = device;
  this.samples = [];
  this.sampleTimes = [];
  this.endPointIn = null;
  this.endPointOut = null;
}

PowerZDevice.prototype = {
  async sample() {
    const CMD_GET_DATA = 0x0C;
    const ATT_ADC = 0x001;
    let outbuf = Buffer.from([CMD_GET_DATA, 0, ATT_ADC << 1, 0]);

    await new Promise((resolve, reject) => {
      this.endPointOut.transfer(outbuf, err => {
        if (err) {
          console.log("error while sending:", err);
          reject(err);
        }
        resolve();
      });
    });

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
      this.device.open();
      this.deviceName = await getDeviceName(this.device);
      console.log("Found device:", this.deviceName);

      await new Promise((resolve, reject) => this.device.reset(error => {
        if (error) {
          console.log("failed to reset device", error);
          reject(error);
        } else {
          resolve();
        }
      }));

      for (let interface of this.device.interfaces) {
        let claimed = false;
        for (let endPoint of interface.endpoints) {
          if (endPoint.transferType != usb.LIBUSB_TRANSFER_TYPE_BULK) {
            continue;
          }
          if (endPoint.direction == "in" && !this.endPointIn) {
            this.endPointIn = endPoint;
            if (!claimed) {
              claimed = true;
              interface.claim();
            }
          }
          if (endPoint.direction == "out" && !this.endPointOut) {
            this.endPointOut = endPoint;
            if (!claimed) {
              claimed = true;
              interface.claim();
            }
          }
        }
      }
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
      this.sampleTimes.push(roundToNanoSecondPrecision(performance.now() - startPerformanceNow));
      this.samples.push(w);
      if (this.sampleTimes.length > MAX_SAMPLES) {
        this.sampleTimes.shift();
        this.samples.shift();
      }
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

const SUPPORTED_DEVICES = {}
SUPPORTED_DEVICES[CHARGER_LAB_VENDOR_ID] = PowerZDevice;

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
  if (vendorId in SUPPORTED_DEVICES) {
    const dev = new SUPPORTED_DEVICES[vendorId](device);
    try {
      await dev.startSampling();
      gDevices.push(dev);
    } catch(e) {
      console.log(e);
    }
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
