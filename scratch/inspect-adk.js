const adk = require('@google/adk');

console.log('--- LlmAgent keys ---');
console.log(Object.getOwnPropertyNames(adk.LlmAgent.prototype));

console.log('--- SequentialAgent keys ---');
console.log(Object.getOwnPropertyNames(adk.SequentialAgent.prototype));

console.log('--- BaseAgent keys ---');
if (adk.BaseAgent) {
  console.log(Object.getOwnPropertyNames(adk.BaseAgent.prototype));
} else {
  console.log('BaseAgent not exported');
}
