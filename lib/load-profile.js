function targetAt(stage, seconds) {
  const from = stage.ramp ? stage.fromTarget : stage.target;
  return from + (stage.target - from) * Math.max(0, Math.min(1, seconds / stage.durationSec));
}
function area(stage, from, to, cap = Infinity) {
  from = Math.max(0, from); to = Math.min(stage.durationSec, to);
  if (to <= from) return 0;
  const a = targetAt(stage, from), b = targetAt(stage, to);
  if (a <= cap && b <= cap) return (a + b) / 2 * (to - from);
  if (a >= cap && b >= cap) return cap * (to - from);
  const crossing = from + (cap - a) / (b - a) * (to - from);
  return a < cap ? (a + cap) / 2 * (crossing - from) + cap * (to - crossing)
    : cap * (crossing - from) + (cap + b) / 2 * (to - crossing);
}
function dueTime(stage, index) {
  let low = 0, high = stage.durationSec;
  for (let i = 0; i < 40; i++) {const mid = (low + high) / 2; if (area(stage, 0, mid) < index) low = mid; else high = mid;}
  return high;
}
module.exports = {targetAt, area, dueTime};
