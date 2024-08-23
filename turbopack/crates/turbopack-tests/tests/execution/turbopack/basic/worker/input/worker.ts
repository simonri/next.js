import dep from './worker-dep'

function getMessage(suffix: string):string{
  return `getMessage ${suffix}`;
}

postMessage(getMessage(dep));
