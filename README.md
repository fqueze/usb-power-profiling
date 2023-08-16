# powerz
Make the ChargerLab Power-Z data usable by the Firefox Profiler.

Running `node powerz.js` will start a server on `localhost:2121`.

Supported requests:
- `GET /profile` will return a profile containing all the data since the script has started. You can view it by [loading it](https://profiler.firefox.com/from-url/http%3A%2F%2Flocalhost%3A2121%2Fprofile/calltree/?v=10) in the [Firefox Profiler](https://profiler.firefox.com).
- `GET /power?start=<start timestamp in ms>&end=<end timestamp in ms>` returns only a power track to be added into a profile from the Gecko Profiler. The start timestamp should be `profile.meta.startTime + profile.meta.profilingStartTime` from the profile and the end timestamp should be `profile.meta.startTime + profile.meta.profilingEndTime`.
