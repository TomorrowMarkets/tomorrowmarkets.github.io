import { defaultSimpleStrategy, validateSimpleStrategy } from '../engine/algo/SimpleEngine.js';
const escape = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const select = (field, values, value, label) => `<label>${label}<select data-f="${field}" class="field">${values.map(([v, name]) => `<option value="${v}"${v === value ? ' selected' : ''}>${name}</option>`).join('')}</select></label>`;
const input = (field, value, label, attrs = '') => `<label>${label}<input data-f="${field}" class="field" type="number" value="${escape(value)}" ${attrs}></label>`;
const metrics = [['price','Price'],['mean','Mean'],['std','Standard deviation'],['rsi','RSI'],['volume','Volume sum'],['return','Return %'],['position','Shares held'],['cash','Cash']];
const windows = [['rolling','Rolling'],['accumulating','Since session start']];

export class SimpleStrategyUI {
  constructor(container, onChange) { this.root = container; this.onChange = onChange; this.strategy = defaultSimpleStrategy();
    container.addEventListener('input', () => this.changed());
    container.addEventListener('change', () => this.changed());
    container.addEventListener('click', event => {
      const button = event.target.closest('[data-simple-action]'); if (!button) return;
      this.read(); const side = button.dataset.side;
      if (button.dataset.simpleAction === 'add' && this.strategy[side].conditions.length < 20) this.strategy[side].conditions.push(defaultSimpleStrategy()[side].conditions[0]);
      if (button.dataset.simpleAction === 'remove' && this.strategy[side].conditions.length > 1) this.strategy[side].conditions.splice(Number(button.dataset.index), 1);
      this.render(); this.onChange?.(this.value());
    });
  }
  set(value) { this.strategy = validateSimpleStrategy(typeof value === 'string' ? JSON.parse(value) : value); this.render(); }
  value() { this.read(); return JSON.stringify(this.strategy, null, 2); }
  changed() { this.read(); this.onChange?.(JSON.stringify(this.strategy, null, 2)); }
  read() {
    for (const side of ['buy','sell']) {
      const section = this.root.querySelector(`[data-simple-side="${side}"]`); if (!section) continue;
      const b = this.strategy[side];
      const value = field => section.querySelector(`[data-block="${field}"]`);
      for (const key of ['join','amountType','orderType']) b[key] = value(key).value;
      for (const key of ['amount','limitOffsetBps','cooldown']) b[key] = Number(value(key).value);
      for (const key of ['enabled','cancelWorking']) b[key] = value(key).checked;
      section.querySelectorAll('[data-condition]').forEach((row, i) => {
        const get = f => row.querySelector(`[data-f="${f}"]`).value;
        b.conditions[i] = { left: {metric:get('leftMetric'),window:get('leftWindow'),period:Number(get('leftPeriod'))},
          operator:get('operator'),right:get('rightKind') === 'number' ? {kind:'number',value:Number(get('rightValue'))}
            : {kind:'metric',metric:get('rightMetric'),window:get('rightWindow'),period:Number(get('rightPeriod'))},
          tolerance:Number(get('tolerance')),persistence:{mode:get('persistence'),count:Number(get('count')),window:Number(get('hitWindow'))} };
        row.querySelector('[data-right-number]').hidden = get('rightKind') !== 'number';
        row.querySelector('[data-right-metric]').hidden = get('rightKind') !== 'metric';
      });
    }
  }
  render() {
    const blockSelect = (field, values, value, label) => select(field, values, value, label).replace('data-f=', 'data-block=');
    const blockInput = (field, value, label, attrs) => input(field, value, label, attrs).replace('data-f=', 'data-block=');
    this.root.innerHTML = `<p class="simple-help">Conditions use completed bars. Rolling indicators need enough history; accumulating indicators start at the session open. If buy and sell both match, no order is placed.</p>` + ['buy','sell'].map(side => {
      const b = this.strategy[side];
      return `<section class="simple-block" data-simple-side="${side}"><div class="simple-title"><h3>${side === 'buy' ? 'Buy rules' : 'Sell rules'}</h3><label><input type="checkbox" data-block="enabled" ${b.enabled?'checked':''}> Enabled</label></div>
        ${blockSelect('join',[['all','All conditions (AND)'],['any','Any condition (OR)']],b.join,'Match')}
        ${b.conditions.map((c,i) => `<div class="simple-condition" data-condition="${i}"><div class="simple-rule-grid">
          ${select('leftMetric',metrics,c.left.metric,'Indicator')}${select('leftWindow',windows,c.left.window,'Window')}${input('leftPeriod',c.left.period,'Bars','min="1" max="200" step="1"')}
          ${select('operator',[['gt','> greater than'],['gte','≥ at least'],['lt','< less than'],['lte','≤ at most'],['around','Around'],['crossAbove','Crosses above'],['crossBelow','Crosses below']],c.operator,'Comparison')}
          ${select('rightKind',[['number','Number'],['metric','Another indicator']],c.right.kind,'Compare with')}
          <div data-right-number ${c.right.kind!=='number'?'hidden':''}>${input('rightValue',c.right.value??0,'Value','step="any"')}</div>
          <div data-right-metric ${c.right.kind!=='metric'?'hidden':''} class="simple-operand">${select('rightMetric',metrics,c.right.metric||'mean','Indicator')}${select('rightWindow',windows,c.right.window||'rolling','Window')}${input('rightPeriod',c.right.period||20,'Bars','min="1" max="200" step="1"')}</div>
          ${input('tolerance',c.tolerance,'Around tolerance %','min="0" max="100" step="any"')}
          ${select('persistence',[['consecutive','Consecutive matches'],['rollingHits','Matches in last N rounds'],['accumulatingHits','Total matches since start']],c.persistence.mode,'Persistence')}
          ${input('count',c.persistence.count,'Required matches','min="1" max="1000" step="1"')}${input('hitWindow',c.persistence.window,'Last N rounds','min="1" max="1000" step="1"')}
        </div><button type="button" class="mini mini-danger" data-simple-action="remove" data-side="${side}" data-index="${i}">Remove condition</button></div>`).join('')}
        <button type="button" class="btn btn-ghost" data-simple-action="add" data-side="${side}">Add condition</button>
        <div class="simple-rule-grid simple-order-settings">
          ${blockInput('amount',b.amount,'Amount','min="0.01" step="any"')}${blockSelect('amountType',[['shares','Shares'],['cashPct','% of available cash'],['positionPct','% of long position']],b.amountType,'Amount unit')}
          ${blockSelect('orderType',[['MARKET','Market'],['LIMIT','Limit']],b.orderType,'Order type')}${blockInput('limitOffsetBps',b.limitOffsetBps,'Limit offset from mid (bps)','min="-1000" max="1000" step="any"')}${blockInput('cooldown',b.cooldown,'Cooldown rounds','min="1" max="1000" step="1"')}
        </div><label class="simple-help"><input type="checkbox" data-block="cancelWorking" ${b.cancelWorking?'checked':''}> Cancel existing working orders before a new signal order</label></section>`;
    }).join('');
  }
}
