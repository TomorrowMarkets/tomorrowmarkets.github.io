export class AlgoLabUI {
 constructor(){document.getElementById('btn-algo-enter').addEventListener('click',()=>{const runner={language:'python',status:'ready',dispose(){},async decide(snapshot){runner.onAction?.({type:'SUBMIT_ORDER',source:'algo',order:{side:'BUY',type:'MARKET',qty:1}});}};this.onReady?.(runner);});document.getElementById('btn-algo-back').addEventListener('click',()=>this.onBack?.());}
 open(){document.getElementById('algo-lab-screen').classList.remove('hidden');}close(){document.getElementById('algo-lab-screen').classList.add('hidden');}
}