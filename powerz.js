const { usb, getDeviceList } = require('usb');
const http = require('http');
const url = require('url');

const VENDOR_ID = 0x5FC9;
const MAX_SAMPLES = 4000000; // About 1.5h at 1kHz.

var gDevice, gEndPointIn, gEndPointOut;
var gDeviceName = "External USB power meter";
var startTime, startPerformanceNow;
var sampleTimes = [];
var samples = [];
var gPromise, gClosing;

function roundToNanoSecondPrecision(timeMs) {
  return Math.round(timeMs * 1e6) / 1e6;
}

async function sample() {
  const CMD_GET_DATA = 0x0C;
  const ATT_ADC = 0x001;
  let outbuf = Buffer.from([CMD_GET_DATA, 0, ATT_ADC << 1, 0]);

  await new Promise((resolve, reject) => {
    gEndPointOut.transfer(outbuf, err => {
      if (err) {
        console.log("error while sending:", err);
        reject(err);
      }
      resolve();
    });
  });

  let data = await new Promise((resolve, reject) => {
    gEndPointIn.transfer(64, (error, data) => {
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
}

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

async function startSampling() {
  startTime = Date.now();
  startPerformanceNow = performance.now();

  gDevice = getDeviceList().find(d => d.deviceDescriptor.idVendor == VENDOR_ID);
  if (!gDevice) {
    console.log("No device found")
    return;
  }

  try {
    gDevice.open();
    gDeviceName = await getDeviceName(gDevice);
    console.log("Found device:", gDeviceName);
    
    await new Promise((resolve, reject) => gDevice.reset(error => {
      if (error) {
        console.log("failed to reset device", error);
        reject(error);
      } else {
        resolve();
      }
    }));

    for (let interface of gDevice.interfaces) {
      let claimed = false;
      for (let endPoint of interface.endpoints) {
        if (endPoint.transferType != usb.LIBUSB_TRANSFER_TYPE_BULK) {
          continue;
        }
        if (endPoint.direction == "in" && !gEndPointIn) {
          gEndPointIn = endPoint;
          if (!claimed) {
            claimed = true;
            interface.claim();
          }
        }
        if (endPoint.direction == "out" && !gEndPointOut) {
          gEndPointOut = endPoint;
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

  if (!gEndPointOut || !gEndPointIn) {
    console.log("failed to find endpoints");
    return;
  }
  
  console.log("Sampling...");
  let previousW = 0;
  let w;
  while (gDevice) {
    do {
      try {
        gPromise = sample();
        w = Math.abs(await gPromise);
        if (gClosing) {
          try {
            gDevice.close();
          } catch(e) {}
          gDevice = null;
          process.exit();
        }
      } catch(e) {
        if (e.code == "ERR_BUFFER_OUT_OF_BOUNDS") {
          // We sometimes get this error on the first sample when the previous
          // shutdown wasn't clean.
          // The next samples work fine, so just ignore the error.
          continue;
        }
        console.log("aborting sampling", e);
        return;
      }
    } while (w == previousW);
    previousW = w;
    sampleTimes.push(roundToNanoSecondPrecision(performance.now() - startPerformanceNow));
    samples.push(w);
    if (sampleTimes.length > MAX_SAMPLES) {
      sampleTimes.shift();
      samples.shift();
    }
  }
}

process.on('SIGINT', function() {
  gClosing = true;
  if (gDevice) {
    if (gPromise) {
      // Should wait for the pending sample to finish.
    } else {
      gDevice.close();
      gDevice = null;
      process.exit();
    }
  } else {
    process.exit();
  }
});

startSampling().then(() => {});

usb.on('attach', async function(device) {
  if (device.deviceDescriptor.idVendor != VENDOR_ID) {
    return;
  }
  device.open();
  console.log("Found device:", await getDeviceName(device));
  device.close();
});
usb.on('detach', function(device) {
  if (device.deviceDescriptor.idVendor != VENDOR_ID) {
    return;
  }
  if (!gDevice) {
    return;
  }
  if (device.busNumber == gDevice.busNumber && device.deviceAddress == gDevice.deviceAddress) {
    console.log("our device has been detached");
    gDevice.close();
    gDevice = null;
  } else {
    console.log("detach", device, gDevice);
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

  let profile = JSON.parse(baseProfile);
  profile.meta.startTime = startTime;
  profile.meta.product = new Date(startTime).toLocaleDateString("fr-FR", {timeZone: "Europe/Paris"}) + " — USB power";
  profile.meta.physicalCPUs = 1;
  profile.meta.CPUName = gDeviceName;

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
      description: gDeviceName,
      fun: i => samples[i],
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
    const query = url.parse(req.url, true).query;
    if (!query.start && !query.end) {
      sendError(res, "power: unexpected case");
      return;
    }

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
    let counter = counterObject("USB power", gDeviceName, times,
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
