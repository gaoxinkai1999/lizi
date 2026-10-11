const shanghaiClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

export function currentShift(now = new Date()) {
  const parts = Object.fromEntries(
    shanghaiClock.formatToParts(now).map(({ type, value }) => [type, value]),
  );
  let date = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = Number(parts.hour);
  if (hour < 7) {
    const previous = new Date(`${date}T12:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    date = previous.toISOString().slice(0, 10);
  }
  return { date, shift: hour >= 7 && hour < 19 ? "day" : "night" };
}
