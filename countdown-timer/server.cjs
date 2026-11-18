'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),os=require('os');
const ROOT=__dirname,PUBLIC=path.join(ROOT,'public'),FILE=process.env.TIMER_STATE_FILE||path.join(ROOT,'timer-state.json');
const PORT=Number(process.env.PORT||8780),HOST=process.env.HOST||'0.0.0.0';
const SCENES=path.resolve(process.env.LED_SCENES_DIR||path.join(ROOT,'..','SPLIT_SCREENS'));
const dims={left:[800,1400],center:[1920,1080],right:[800,1400]};
const presets={left:{x:40,y:510,width:720,visible:true},center:{x:1540,y:70,width:290,visible:true},right:{x:40,y:510,width:720,visible:true}};
const initial={durationMs:3600000,remainingMs:3600000,deadline:null,status:'ready',revision:0,scene:'transparent',showLogo:true,warningSeconds:60,layouts:presets};
let saved;try{saved=JSON.parse(fs.readFileSync(FILE,'utf8'))}catch{}
let state={...initial,...saved,layouts:{...presets,...saved?.layouts}};let controlKey=saved?.controlKey||crypto.randomBytes(24).toString('hex');
delete state.controlKey;
const pinFile = path.join(ROOT, 'control-pin.txt');
const pin = process.env.TIMER_CONTROL_PIN ?? (fs.existsSync(pinFile) ? fs.readFileSync(pinFile,'utf8').trim() : '');
if (pin && !/^\d{4,12}$/.test(pin)) throw Error('Control PIN must contain 4–12 digits');
const sessionToken = crypto.randomBytes(32).toString('hex');
const attempts = new Map();
function pinSession(req) {
  return (req.headers.cookie||'').split(';').some(value=>value.trim() === 'timer_session='+sessionToken);
}
function showPinForm(res, status=200, error='') {
  res.writeHead(status, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
  const cells = '<span></span>'.repeat(pin.length);
  res.end(`<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Countdown Control</title><link rel="stylesheet" href="/control.css"></head>
<body class="pin-page"><main class="pin-card"><div class="pin-brand"><img src="/assets/bastion-logo.svg" alt="Bastion Esports Design"></div><h1>Countdown Control</h1>
<form method="post" action="/control/login"><label for="pin">กรอก PIN ${pin.length} หลัก</label>
<div class="pin-entry"><div class="pin-cells" aria-hidden="true" style="--pin-count:${pin.length}">${cells}</div>
<input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{${pin.length}}" autocomplete="current-password" required maxlength="${pin.length}"></div>
<p class="pin-error" role="status">${error}</p><button class="primary">เข้าสู่หน้าควบคุม</button></form></main>
<script>const input=document.querySelector("#pin"), cells=[...document.querySelectorAll(".pin-cells span")];
function paint(){cells.forEach((cell,i)=>{cell.textContent=i<input.value.length?"●":"";cell.classList.toggle("filled",i<input.value.length);cell.classList.toggle("current",i===input.value.length)})}
input.addEventListener("input",()=>{input.value=input.value.replace(/[^0-9]/g,"");paint()});paint();</script></body></html>`);
}
async function login(req,res) {
  const ip=req.socket.remoteAddress;
  const now=Date.now();
  for(const [address,record] of attempts) if(record.until<=now) attempts.delete(address);
  const record=attempts.get(ip)||{count:0,until:now+60000};
  if(record.count>=5) return showPinForm(res,429,'ลองใหม่ในอีกหนึ่งนาที');
  record.count++;
  attempts.set(ip,record);
  let body='';
  for await(const chunk of req){body+=chunk;if(body.length>512)return showPinForm(res,413,'ข้อมูลมากเกินไป')}
  const entered=Buffer.from(new URLSearchParams(body).get('pin')||'');
  const expected=Buffer.from(pin);
  if(entered.length!==expected.length||!crypto.timingSafeEqual(entered,expected))return showPinForm(res,403,'PIN ไม่ถูกต้อง');
  attempts.delete(ip);
  res.writeHead(303,{Location:'/control','Set-Cookie':'timer_session='+sessionToken+'; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200','Cache-Control':'no-store'});
  res.end();
}
const clients=new Map();let closing=false;
function persist(){const temp=FILE+'.tmp';fs.writeFileSync(temp,JSON.stringify({...state,controlKey},null,2));fs.renameSync(temp,FILE)}
function remaining(){return state.status==='running'?Math.max(0,state.deadline-Date.now()):state.remainingMs}
function snapshot(){return{...state,remainingMs:remaining(),serverNow:Date.now()}}
function settle(){if(state.status==='running'&&remaining()===0){state={...state,status:'finished',deadline:null,remainingMs:0,revision:state.revision+1};persist();broadcast();}}
function broadcast(){const msg='event: state\ndata: '+JSON.stringify(snapshot())+'\n\n';for(const res of clients.keys())res.write(msg)}
function catalogue(){if(!fs.existsSync(SCENES))return[];return fs.readdirSync(SCENES,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>({id:d.name,name:d.name.replace(/^LED_/,'').replaceAll('_',' '),files:fs.readdirSync(path.join(SCENES,d.name)).filter(f=>/\.png$/i.test(f))})).filter(s=>Object.keys(dims).every(k=>s.files.some(f=>f.includes('_'+k.toUpperCase()+'_'))))}
function send(res,code,data){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))}
function isLocal(req){return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)}
function authorized(req){const a=Buffer.from(req.headers['x-control-key']||''),b=Buffer.from(controlKey);return a.length===b.length&&crypto.timingSafeEqual(a,b)}
function clamp(n,min,max){return Math.max(min,Math.min(max,n))}
function mutate(body){const action=body.action;switch(action){
case 'set':{const seconds=Number(body.seconds);if(!Number.isFinite(seconds)||seconds<1||seconds>359999)throw Error('ตั้งเวลาได้ตั้งแต่ 1 วินาที ถึง 99:59:59');state.durationMs=Math.round(seconds*1000);state.remainingMs=state.durationMs;state.deadline=null;state.status='ready';break}
case 'start':if(state.status!=='running'){if(state.remainingMs<=0)state.remainingMs=state.durationMs;state.deadline=Date.now()+state.remainingMs;state.status='running'}break;
case 'pause':if(state.status==='running'){state.remainingMs=remaining();state.deadline=null;state.status='paused'}break;
case 'reset':state.remainingMs=state.durationMs;state.deadline=null;state.status='ready';break;
case 'adjust':{const n=Number(body.seconds);if(!Number.isFinite(n)||Math.abs(n)>3600)throw Error('ค่าเพิ่ม/ลดเวลาไม่ถูกต้อง');const ms=clamp(remaining()+n*1000,0,359999000);state.remainingMs=ms;if(state.status==='running')state.deadline=Date.now()+ms;if(ms===0){state.deadline=null;state.status='finished'}else if(state.status==='finished')state.status='paused';break}
case 'config':{if(body.scene!==undefined){if(body.scene!=='transparent'&&!catalogue().some(s=>s.id===body.scene))throw Error('ไม่พบซีน');state.scene=body.scene}if(typeof body.showLogo==='boolean')state.showLogo=body.showLogo;if(body.warningSeconds!==undefined){const w=Number(body.warningSeconds);if(!Number.isFinite(w))throw Error('ค่าเตือนไม่ถูกต้อง');state.warningSeconds=clamp(Math.round(w),0,3600)}if(body.layouts){for(const [key,v]of Object.entries(body.layouts)){if(!dims[key])throw Error('ไม่พบจอ');const [w,h]=dims[key],old=state.layouts[key],width=Number(v.width??old.width),x=Number(v.x??old.x),y=Number(v.y??old.y);if(![width,x,y].every(Number.isFinite))throw Error('ตำแหน่งไม่ถูกต้อง');const ww=clamp(width,120,w);state.layouts[key]={width:ww,x:clamp(x,0,w-ww),y:clamp(y,0,h-ww*.65),visible:typeof v.visible==='boolean'?v.visible:old.visible}}}break}
default:throw Error('คำสั่งไม่ถูกต้อง')}
state.revision++;persist();broadcast();return snapshot()}
function serveFile(res,file){fs.stat(file,(err,stat)=>{if(err||!stat.isFile())return send(res,404,{error:'ไม่พบไฟล์'});const ext=path.extname(file),mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ttf':'font/ttf'}[ext]||'application/octet-stream';res.writeHead(200,{'Content-Type':mime,'Content-Length':stat.size,'Cache-Control':'no-cache'});fs.createReadStream(file).pipe(res)})}
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');const pathname=decodeURIComponent(url.pathname);
if(pathname==='/'){if(isLocal(req)){res.writeHead(302,{Location:pin?'/control':'/control?key='+controlKey});return res.end()}res.writeHead(302,{Location:'/out/center'});return res.end()}
if(pin&&pathname==='/control/login'&&req.method==='POST')return await login(req,res);
if(pathname==='/api/time')return send(res,200,{serverNow:Date.now()});
if(pathname==='/api/health')return send(res,200,{service:'binance-countdown',version:1});
if(pathname==='/api/shutdown'&&req.method==='POST'){if(!isLocal(req)||!authorized(req))return send(res,403,{error:'Unauthorized'});send(res,200,{stopping:true});setTimeout(shutdown,100);return}
if(pathname==='/api/state'){settle();return send(res,200,snapshot())}
if(pathname==='/api/scenes')return send(res,200,catalogue().map(({id,name})=>({id,name})));
if(pathname==='/api/outputs')return send(res,200,{clients:[...clients.values()],port:PORT,lan:Object.values(os.networkInterfaces()).flat().filter(n=>n&&n.family==='IPv4'&&!n.internal).map(n=>'http://'+n.address+':'+PORT),host:HOST});
if(pathname==='/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive'});res.write('retry: 1000\n\n');clients.set(res,{screen:url.searchParams.get('screen')||'control',preview:url.searchParams.get('preview')==='1'});res.write('event: state\ndata: '+JSON.stringify(snapshot())+'\n\n');req.on('close',()=>clients.delete(res));return}
if(pathname==='/api/action'&&req.method==='POST'){if(pin?!pinSession(req):!authorized(req))return send(res,403,{error:'เปิดหน้า Control จากลิงก์ของเครื่องหลักเพื่อควบคุมเวลา'});let body='';for await(const chunk of req){body+=chunk;if(body.length>16384)return send(res,413,{error:'ข้อมูลมากเกินไป'})}let data;try{data=JSON.parse(body)}catch{return send(res,400,{error:'ข้อมูลไม่ถูกต้อง'})}const backup=structuredClone(state);try{return send(res,200,mutate(data))}catch(e){state=backup;return send(res,400,{error:e.message})}}
if(pathname.startsWith('/scene/')){const bits=pathname.split('/').filter(Boolean);if(bits.length!==3)return send(res,404,{});const [,id,side]=bits,s=catalogue().find(x=>x.id===id);if(!s||!dims[side])return send(res,404,{});const f=s.files.find(x=>x.includes('_'+side.toUpperCase()+'_'));return serveFile(res,path.join(SCENES,id,f))}
if(pin&&['/control','/control.html'].includes(pathname)&&!pinSession(req))return showPinForm(res);
if(pathname==='/control')return serveFile(res,path.join(PUBLIC,'control.html'));
if(/^\/out\/(left|center|right|side)$/.test(pathname))return serveFile(res,path.join(PUBLIC,'output.html'));
const file=path.resolve(PUBLIC,'.'+pathname);if(!file.startsWith(PUBLIC+path.sep))return send(res,403,{});return serveFile(res,file);
}catch(e){send(res,500,{error:'ระบบไม่สามารถดำเนินการได้'})}});
const tick=setInterval(settle,100),heartbeat=setInterval(()=>{for(const res of clients.keys())res.write(': heartbeat\n\n')},5000);settle();persist();
server.listen(PORT,HOST,()=>{console.log('Binance Countdown Timer');console.log('CONTROL http://127.0.0.1:'+PORT+'/');console.log('OUTPUT /out/left | /out/center | /out/right');console.log('HOST '+HOST+' | SCENES '+SCENES)});
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'พอร์ต '+PORT+' ถูกใช้งานอยู่ — เปิด http://127.0.0.1:'+PORT+'/ หรือเปลี่ยน PORT':e.message);process.exit(1)});
function shutdown(){if(closing)return;closing=true;clearInterval(tick);clearInterval(heartbeat);persist();for(const res of clients.keys())res.end();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),2000).unref()}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
