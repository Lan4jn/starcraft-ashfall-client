// worker.js fixture
self.onmessage = (e) => {
  self.postMessage({ echo: e.data });
};
