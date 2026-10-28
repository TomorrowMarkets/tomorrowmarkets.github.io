export const SESSION_OPEN_SECS = 34200;
export const SESSION_CLOSE_SECS = 64800;
export const SESSION_SECONDS = SESSION_CLOSE_SECS - SESSION_OPEN_SECS;
export const MICRO_SECONDS = 15;
export function sessionPlan({ sessionDays = 5, barMinutes = 5, durationMinutes = 20 } = {}) {
  if (![1,5].includes(sessionDays) || ![0.25,5,10,15].includes(barMinutes) || ![10,15,20].includes(durationMinutes)) {
    throw new Error('Choose 1 or 5 sessions, 5/10/15-minute bars, and a 10/15/20-minute game.');
  }
  const barSeconds = barMinutes * 60;
  const barsPerDay = SESSION_SECONDS / barSeconds;
  return { sessionDays, barMinutes, durationMinutes, barSeconds, barsPerDay,
    microPerBar: barSeconds / MICRO_SECONDS, totalTicks: barsPerDay * sessionDays,
    tickIntervalMs: durationMinutes * 60000 / (barsPerDay * sessionDays) };
}

export function sourceSessions(dataset) {
  const days = new Map();
  dataset.frames.forEach((frame) => {
    const day = frame.sessionDate || new Date(frame.timestamp).toISOString().slice(0,10);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(frame);
  });
  return [...days.entries()].map(([date, frames]) => ({ date, frames }));
}

export function selectHistoricalSessions(dataset, count, random = Math.random, startDate = null) {
  const days = sourceSessions(dataset);
  if (days.length < count) throw new Error(`This dataset contains ${days.length} session(s); load ${count} sessions or select a shorter challenge.`);
  const start = startDate ? days.findIndex(day => day.date === startDate) : Math.min(days.length-count, Math.floor(random() * (days.length-count+1)));
  if (start < 0 || start + count > days.length) throw new Error('That start date does not have enough recorded sessions. Choose a date present in the dataset.');
  const selected = days.slice(start,start+count);
  return {...dataset,frames:selected.flatMap(day=>day.frames),windowStart:selected[0].date,windowEnd:selected.at(-1).date};
}
