// entry.js fixture
import('./worker.js');
const worker = new Worker(new URL('./worker.js', import.meta.url));
console.log('fixture entry initialized', worker);
