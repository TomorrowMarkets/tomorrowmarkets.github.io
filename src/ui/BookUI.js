
import { events } from '../EventBus.js';

export class BookUI {
  constructor() {
    this.bidsTable = document.getElementById('bids-body');
    this.asksTable = document.getElementById('asks-body');

    // Subscribe to OrderBook updates
    events.on('ORDER_BOOK_UPDATED', (book) => this.render(book));
  }

  render({ bids, asks }) {
    this.bidsTable.innerHTML = bids.map(b => 
      `<tr class="bid"><td>$${b.price}</td><td>${b.size}</td></tr>`
    ).join('');

    this.asksTable.innerHTML = asks.map(a => 
      `<tr class="ask"><td>$${a.price}</td><td>${a.size}</td></tr>`
    ).join('');
  }
}
