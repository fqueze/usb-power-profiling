Make the data from USB power meters usable in the Firefox Profiler.

# Quick start
The following instructions will start a server on `localhost:2121`.
```
git clone https://github.com/fqueze/usb-power-profiling.git
cd usb-power-profiling
npm i
node usb-power-profiling.js
```

Then open [the Firefox Profiler UI](https://profiler.firefox.com/from-url/http%3A%2F%2Flocalhost%3A2121%2Fprofile/calltree/) to load the data from the meter. You can also load [http://localhost:2121/](http://localhost:2121/) in your browser to see a live power profile (updated every 5 seconds).

## External power profiling in the Firefox Profiler
In Firefox 121 or later:
- in `about:config`, set the `devtools.performance.recording.power.external-url` preference to `http://localhost:2121/power`.
- use the 'power' preset (or any configuration that uses the 'power' feature) when starting the profiler.
- When capturing the profile, the Firefox Profiler will automatically fetch additional power tracks and add them to the profile.

## Seeing a profile containing only the data from the USB power meter

[Load](https://profiler.firefox.com/from-url/http%3A%2F%2Flocalhost%3A2121%2Fprofile/calltree/?v=10) `http://localhost:2121/profile` in the [Firefox Profiler](https://profiler.firefox.com). 

## HTTP API
- `GET /profile` will return a profile containing all the data since the script has started. You can view it by [loading it](https://profiler.firefox.com/from-url/http%3A%2F%2Flocalhost%3A2121%2Fprofile/calltree/?v=10) in the [Firefox Profiler](https://profiler.firefox.com).
- `GET /power?start=<start timestamp in ms>&end=<end timestamp in ms>` returns only a power track to be added into a profile from the Gecko Profiler. The start timestamp should be `profile.meta.startTime + profile.meta.profilingStartTime` from the profile and the end timestamp should be `profile.meta.startTime + profile.meta.profilingEndTime`.
- `GET /rawdata?last=<timestamp>` returns all the stored data in JSON format if the last timestamp is omitted, or all data more recent than the provided last timestamp if it is provided. This API is used by the live profiling web UI.

# Supported devices
## Power meters known to work
The example profiles are taken using a USB light, first keeping the light off for a while to record noise from the power meter, then turning the light on at different levels of brightness for about 5s, and finally turning the light off again.
|Brand|Model|Example profile|Min interval between samples|Notes|
|---|---|---|---|---|
|ChargerLab Power-Z|FL001 Super|https://share.firefox.dev/4714rQQ|32ms|   |
|ChargerLab Power-Z|KM001Pro   |https://share.firefox.dev/4ag8xqN|2ms|   |
|ChargerLab Power-Z|KT002      |https://share.firefox.dev/3RkPsvf|1ms|Samples contain timestamps in µs, and sampling is driven by the power meter, making the sampling rate very consistent (no degradation of the data when the USB bus is busy)|
|ChargerLab Power-Z|KM003C     |https://share.firefox.dev/3Rg6z15|1ms|Sampling driven by the computer, causing overhead on the computer and relying on the USB communication being smooth.|
|Shizuku	YK-Lab|YK001 |||See Power-Z KT002. Alternative names: AVHzY CT-3, Power-Z KT002, or ATORCH UT18.|
|Shizuku	YK-Lab|YK003C|||See AVHzY C3.|
|AVHzY|CT-3      |||See Power-Z KT002. |
|AVHzY|C3        |https://share.firefox.dev/41BVhcf|1ms|Samples contain timestamps in µs, and sampling is driven by the power meter, making the sampling rate very consistent (no degradation of the data when the USB bus is busy)|
|AVHzY|TC66C (RD)|||See RuiDeng TC66C|
|FNIRSI|C1    |https://share.firefox.dev/4asQhLh|10ms|Significant power use changes are smoothed over 500ms.|
|FNIRSI|FNB48S|https://share.firefox.dev/3RjtVTl|10ms|Significant power use changes are smoothed over 120ms.|
|RuiDeng|TC66C|https://share.firefox.dev/3v4AvFV|80ms|Sampling rate depends on how much data is displayed on the power meter's screen. With the full display, 100ms is the minimum interval between samples. With only the main 3 values displayed, 90ms is in the minimum between samples, with a static screen (eg. settings) the minimum interval is 80ms. Significant power changes take up to [500ms to stabilize](https://share.firefox.dev/48w6Hkc) (with a few samples showing only a part of the change).|
|WITRN|C5|https://share.firefox.dev/41nqAaQ|10ms|Samples contain timestamps in ms.|
|ATORCH|ACD15P|https://share.firefox.dev/3SIWpGS|1s|Very low sampling rate.|
|YZXStudio|1280E|https://share.firefox.dev/3Wr9HeW|250ms|Low sampling rate. Significant power changes take up to 500ms (2 samples) to stabilize. Seems to have a low level of noise, making it possible to see a difference between low power values ( <10mW) and 0.|
## Power meters likely to work
Compatibility with these devices has not been verified, but they are likely to either "just work", or work with a trivial adjustment to the code (eg. tweak a USB product id).
|Brand|Model|Notes|
|---|---|---|
|ChargerLab Power-Z|KM002C|Same protocol as the KM003C.|
|FNIRSI|FNB48|Expected to use the same protocol as the FNIRSI C1.|
|FNIRSI|FNB48P|Expected to be the same as the FNIRSI FNB48S in a different package.|
|FNIRSI|FNB58|Expected to use the same protocol as the FNIRSI FNB48S.|
|RuiDeng|TC66|Expected to use the same protocol as the TC66C.|
|WITRN|A2|Expected to use the same protocol as the C5.|
|WITRN|A2L|Expected to use the same protocol as the C5.|
|WITRN|A2C|Expected to use the same protocol as the C5.|
|WITRN|U3|Expected to use the same protocol as the C5.|
|WITRN|U3L|Expected to use the same protocol as the C5.|
|WITRN|C4 / C4L|Expected to be the same as the C5 with lower data precision.|
|ATORCH|C13P|Expected to be the same as the ACD15P.|

# Installation on Windows
Windows requires the WinUSB driver to be installed and bound in order to work.

The instructions below are for the `AVHzY CT-3`. The USB ID at least will be different for other devices.
- Install Zadig driver installer from https://zadig.akeo.ie/
- Plug in the USB power meter and run the Zadig application
- Disable the Options -> Ignore Hubs or Composite Parents option in the menu
- Select the USB device for the meter (for CT-3 it is USB ID 0483 FFFE)
- Click Replace to install the default WinUSB driver

With those steps, it should now be possible to run the node application above and sample power.
