import * as adk from '@google/adk';

console.log('ADK exports:', Object.keys(adk));
console.log('LlmAgent prototype:', Object.getOwnPropertyNames(adk.LlmAgent.prototype));
console.log('SequentialAgent prototype:', Object.getOwnPropertyNames(adk.SequentialAgent.prototype));
console.log('InMemoryRunner prototype:', Object.getOwnPropertyNames(adk.InMemoryRunner.prototype));
