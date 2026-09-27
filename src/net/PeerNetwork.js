// src/net/PeerNetwork.js
// WebRTC transport over PeerJS.
//
// Two things matter here for a busy room:
//
//   * broadcast() encodes the message ONCE and hands the same string to every
//     connection. PeerJS serialises on every send(), so passing it an object
//     re-packed the same payload once per player and made the host's cost grow
//     with the room size.
//   * send(conn, data) exists so private messages (your own orders, your own
//     notices) go to one player instead of to everyone with a filter on the
//     far side.
//
// Events on the bus:
//   NET_CLIENT_CONNECTED     conn            (host: somebody arrived)
//   NET_CLIENT_DISCONNECTED  conn            (host: somebody left)
//   NET_HOST_CONNECTED                       (client: we're in)
//   NET_HOST_LOST                            (client: the host vanished)
//   NET_DATA_RECEIVED        { conn, data }
//   NET_ERROR                { kind, message }
//                            kind: 'room-taken' | 'no-room' | 'network' | 'other'

const roomId = (code) => 'tm-room-' + code;

// A client's peer id must be globally unique on the broker. It used to be the
// player's handle, so two people called "Mark" anywhere on the site collided
// and the second one failed silently. It's now a random session id, and the
// handle travels in the JOIN_LOBBY message where it belongs.
const sessionId = () => 'tm-c-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function encode(data) {
  return typeof data === 'string' ? data : JSON.stringify(data);
}

function decode(raw) {
  if (typeof raw !== 'string') return raw; // older shape, or a non-JSON frame
  try { return JSON.parse(raw); } catch (err) { return null; }
}

function classifyError(err) {
  const type = (err && err.type) || '';
  if (type === 'unavailable-id') return 'room-taken';
  if (type === 'peer-unavailable') return 'no-room';
  if (type === 'network' || type === 'disconnected' || type === 'socket-error' || type === 'server-error') return 'network';
  return 'other';
}

export class PeerNetwork {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.peer = null;
    this.connections = [];
    this.hostConn = null;
    this.isHost = false;
    // Closing the tab closes our connections properly, so the room hears
    // about it straight away instead of waiting for a timeout.
    window.addEventListener('pagehide', () => this.close());
  }

  emit(event, payload) {
    if (this.eventBus) this.eventBus.emit(event, payload);
  }

  /**
   * Claim a room code and host it. Resolves true once the broker accepts the
   * code, false if somebody already holds it — which is exactly how public
   * lobbies elect their host: first to claim the slot's code runs the market.
   */
  initHost(roomCode) {
    this.close();
    this.isHost = true;
    const peer = new Peer(roomId(roomCode));
    this.peer = peer;

    peer.on('connection', (conn) => {
      this.connections.push(conn);

      conn.on('data', (raw) => {
        const data = decode(raw);
        if (data) this.emit('NET_DATA_RECEIVED', { conn, data });
      });

      // 'close' doesn't always fire when a player's tab simply disappears,
      // so a failed or disconnected WebRTC link counts as leaving too.
      let gone = false;
      const leave = () => {
        if (gone) return;
        gone = true;
        this.connections = this.connections.filter((c) => c !== conn);
        this.emit('NET_CLIENT_DISCONNECTED', conn);
      };
      conn.on('close', leave);
      conn.on('error', leave);
      conn.on('iceStateChanged', (state) => {
        if (state === 'failed' || state === 'closed' || state === 'disconnected') leave();
      });

      this.emit('NET_CLIENT_CONNECTED', conn);
    });

    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      peer.on('open', () => finish(true));
      peer.on('error', (err) => {
        const kind = classifyError(err);
        if (kind === 'room-taken') {
          // Expected during host election; not worth a toast.
          if (this.peer === peer) { peer.destroy(); this.peer = null; this.isHost = false; }
          finish(false);
          return;
        }
        this.emit('NET_ERROR', { kind, message: (err && err.message) || 'Connection problem.' });
        finish(false);
      });
    });
  }

  /**
   * Join a room. Resolves true when the host's data channel opens, false if
   * nobody is hosting that code or the connection failed.
   */
  initClient(roomCode) {
    this.close();
    this.isHost = false;
    const peer = new Peer(sessionId());
    this.peer = peer;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      peer.on('open', () => {
        const conn = peer.connect(roomId(roomCode));
        this.hostConn = conn;

        conn.on('open', () => {
          this.emit('NET_HOST_CONNECTED');
          finish(true);
        });

        conn.on('data', (raw) => {
          const data = decode(raw);
          if (data) this.emit('NET_DATA_RECEIVED', { data });
        });

        // The host closing its tab, or the link dying, both mean the game is
        // over for us. Clients used to just freeze with no explanation.
        let lost = false;
        const hostGone = () => {
          if (lost) return;
          lost = true;
          this.hostConn = null;
          if (settled) this.emit('NET_HOST_LOST');
          finish(false);
        };
        conn.on('close', hostGone);
        conn.on('error', hostGone);
        conn.on('iceStateChanged', (state) => {
          if (state === 'failed' || state === 'closed' || state === 'disconnected') hostGone();
        });
      });

      peer.on('error', (err) => {
        const kind = classifyError(err);
        if (kind !== 'no-room') this.emit('NET_ERROR', { kind, message: (err && err.message) || 'Connection problem.' });
        finish(false);
      });
    });
  }

  /** Is anybody hosting this room code? Used to find an open public lobby. */
  probe(roomCode, timeoutMs = 3000) {
    return new Promise((resolve) => {
      let peer;
      try { peer = new Peer(sessionId()); } catch (err) { resolve(false); return; }
      let settled = false;
      const finish = (found) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { peer.destroy(); } catch (err) { /* already gone */ }
        resolve(found);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      peer.on('open', () => {
        const conn = peer.connect(roomId(roomCode));
        conn.on('open', () => finish(true));
        conn.on('error', () => finish(false));
      });
      peer.on('error', () => finish(false));
    });
  }

  /** Send to one connection (host only). */
  send(conn, data) {
    if (conn && conn.open) conn.send(encode(data));
  }

  /** Host: send to every player. Client: send to the host. */
  broadcast(data) {
    const wire = encode(data); // encoded once, not once per player
    if (this.isHost) {
      for (const conn of this.connections) {
        if (conn.open) conn.send(wire);
      }
    } else if (this.hostConn && this.hostConn.open) {
      this.hostConn.send(wire);
    }
  }

  close() {
    if (this.peer && !this.peer.destroyed) {
      try { this.peer.destroy(); } catch (err) { /* already gone */ }
    }
    this.peer = null;
    this.connections = [];
    this.hostConn = null;
  }
}
