// src/services/public-lobby.js
// Public lobbies: a game anybody can drop into, without a room code.
//
// How players find each other with no server
// ------------------------------------------
// The clock is the meeting point. Every 10 minutes is a "slot", and a slot's
// room code is derived from the clock, so everyone computes the same one:
//
//   slot 2892345  ->  room code "pub-2892345"
//
// Whoever arrives first claims that code on the PeerJS broker and becomes the
// host. Everyone after them finds it taken and joins as a client. No backend,
// no matchmaking service, no accounts.
//
// A lobby also keeps absorbing arrivals through the FOLLOWING slot, so a game
// that is still two players short at the ten-minute mark doesn't strand them.
// A new arrival therefore looks for a lobby in this order:
//
//   1. the previous slot, if one is still gathering there
//   2. this slot: claim it and host, or join whoever beat us to it
//
// When it actually starts
// -----------------------
//   under 3 waiting   doors open, no countdown (a game needs 3 to be a game)
//   3 to 10           60 seconds
//   11 to 19          30 seconds
//   20                10 seconds, and the doors lock
//
// The countdown starts the moment the third player arrives, and only ever
// shortens as the room fills. It never restarts, so nobody can hold a lobby
// open by joining and leaving.
//
// Public lobbies are discretionary only for now. The slot key carries the mode
// so an algorithmic track can be added later without changing any of this.

export const SLOT_MINUTES = 10;
export const SLOT_MS = SLOT_MINUTES * 60 * 1000;
export const MIN_PUBLIC_PLAYERS = 3;
export const MAX_PUBLIC_PLAYERS = 20;

// [minimum players, countdown]. First match wins, so keep it descending.
const COUNTDOWNS = [
  [MAX_PUBLIC_PLAYERS, 10_000],
  [11, 30_000],
  [MIN_PUBLIC_PLAYERS, 60_000]
];

export function slotIndexAt(now = Date.now()) {
  return Math.floor(now / SLOT_MS);
}

export function slotCode(index, mode = 'discretionary') {
  return mode === 'discretionary' ? `pub-${index}` : `pub${mode[0]}-${index}`;
}

export function slotStartsAt(index) {
  return index * SLOT_MS;
}

/** "10:20" — when this slot's doors opened, in the player's own time zone. */
export function describeSlot(index) {
  return new Date(slotStartsAt(index)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Milliseconds until the next slot opens. */
export function msToNextSlot(now = Date.now()) {
  return SLOT_MS - (now % SLOT_MS);
}

/** How long a room with this many players waits, or null for "keep waiting". */
export function countdownFor(players) {
  for (const [min, ms] of COUNTDOWNS) {
    if (players >= min) return ms;
  }
  return null;
}

export function isFull(players) {
  return players >= MAX_PUBLIC_PLAYERS;
}

/**
 * Find a public lobby to be part of.
 * Resolves { role: 'host' | 'client', code, slot }, or null if the network
 * wouldn't cooperate. `onStatus` gets a short line for the loading screen.
 */
export async function findPublicRoom(peerNetwork, { mode = 'discretionary', onStatus = () => {} } = {}) {
  const slot = slotIndexAt();
  const thisCode = slotCode(slot, mode);
  const lastCode = slotCode(slot - 1, mode);

  // 1. Is the previous slot's lobby still gathering? Join it rather than
  //    starting a rival room three minutes before it fills.
  onStatus('Looking for a game…');
  if (await peerNetwork.probe(lastCode)) {
    onStatus('Joining a game already gathering…');
    if (await peerNetwork.initClient(lastCode)) return { role: 'client', code: lastCode, slot: slot - 1 };
  }

  // 2. Claim this slot. Winning means we host it; losing means somebody
  //    beat us by a moment and we join them instead.
  onStatus('Opening a table…');
  if (await peerNetwork.initHost(thisCode)) return { role: 'host', code: thisCode, slot };

  onStatus('Joining the table…');
  if (await peerNetwork.initClient(thisCode)) return { role: 'client', code: thisCode, slot };

  return null;
}

/**
 * The host's countdown. Feed it the player count whenever the room changes;
 * it decides when to start and reports the seconds left.
 *
 *   const cd = new PublicCountdown({
 *     onTick: (secs, players) => showLine(secs, players),
 *     onStart: () => startTheGame()
 *   });
 *   cd.update(connectedPlayers.length);
 */
export class PublicCountdown {
  constructor({ onTick = () => {}, onStart = () => {} } = {}) {
    this.onTick = onTick;
    this.onStart = onStart;
    this.endsAt = null;
    this.players = 0;
    this.fired = false;
    this.timer = setInterval(() => this.pump(), 250);
  }

  update(players) {
    this.players = players;
    if (this.fired) return;

    const want = countdownFor(players);
    if (want == null) {
      // Dropped back under three: hold the doors open again.
      this.endsAt = null;
      this.onTick(null, players);
      return;
    }
    const target = Date.now() + want;
    // Only ever shorten. A room that fills up hurries; a room that empties
    // and refills doesn't get a fresh 60 seconds.
    if (this.endsAt == null || target < this.endsAt) this.endsAt = target;
    this.pump();
  }

  pump() {
    if (this.fired || this.endsAt == null) return;
    const left = this.endsAt - Date.now();
    if (left <= 0) {
      this.fired = true;
      this.stop();
      this.onStart();
      return;
    }
    this.onTick(Math.ceil(left / 1000), this.players);
  }

  get locked() {
    return isFull(this.players);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
