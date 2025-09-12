// A richer program to exercise debugger scope/stack inspection
console.log('begin');

function makeCounter(start) {
  let count = start;
  const meta = { tag: 'C', list: [1, 2], nested: { a: 1 } };
  return function inc(step) {
    const s = step ?? 1;
    const before = count;
    count += s;
    console.log('inc', { before, s, count, metaTag: meta.tag });
    debugger; // pause inside closure with locals + closure vars
    return count;
  };
}

class Calc {
  constructor(mult) {
    this.mult = mult;
  }
  times(n) {
    const out = n * this.mult;
    debugger; // pause with `this` and locals
    return out;
  }
}

const inc1 = makeCounter(10);
const c = new Calc(3);
const a1 = inc1(2);
const a2 = c.times(5);
console.log('done', { a1, a2 });

