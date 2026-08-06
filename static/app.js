/* =====================================================================
   ISSAS web — client
   All annotation is stored at NATIVE frame resolution. Zoom/pan are a pure
   display transform; screen->image conversion happens in toImg().
   ===================================================================== */

const $ = (id) => document.getElementById(id);
const API = {
  post: (url, body) => fetch(url, {method:'POST', headers:{'Content-Type':'application/json'},
                                   body: JSON.stringify(body||{})}).then(r=>r.json().then(j=>({ok:r.ok,j}))),
  get:  (url) => fetch(url).then(r=>r.json()),
};

// ---------- global state ----------
const S = {
  frames: [], count: 0, idx: 0, W: 0, H: 0,
  sam2: false, device: 'cpu',
  classMap: {},
  classGroups: {tissue:{}, instrument:{}},
  defaultPath: null,
  user: 'ISSAS_USER',
  objects: new Map(),     // objId -> {id, classId, name, color:[r,g,b], bin:Uint8Array, tint:Canvas|null, visible, centroid:[x,y]}
  order: [],              // objId order for W/S cycling & list
  currentId: null,
  // per-frame prompt state (display only)
  points: new Map(),      // objId -> [{x,y,label}]
  boxes:  new Map(),      // objId -> [x1,y1,x2,y2]
  // view transform (CSS px)
  scale: 1, panX: 0, panY: 0,
  // interaction
  brush: false, brushSize: 20, brushing: false, brushPositive: true,
  dragBox: false, boxStart: null, tempBox: null,
  panning: false, panStart: null, spaceDown: false,
  // visualization toggles
  vis: {fill:true, boundary:true, ids:true, points:true, boxes:false, all:true},
  visRev: 0,
  boxFlash: null,
  propagation: true,
  // post-processing params
  gauss: 17, morph: 17, comp: 1,
  // undo
  history: [], maxHistory: 15,
  dirty: false,            // unsaved human edits on the current frame
  refineSrc: null,         // when set, each new frame auto-imports this annotator's mask
  // sticky import folders: chosen once, then reused for every later import (Q / click)
  maskDir: null,
  promptsDir: null,
  // per-frame mask memory + object flash
  frameMasks: new Map(),   // frameIdx -> Map(objId -> Uint8Array bin)   [human-final]
  rawMasks: new Map(),     // frameIdx -> Map(objId -> {bin, kind, classId, locked})  [SAM2 raw]
  flash: null,             // {id, start, dur}
  img: null,               // HTMLImageElement of current frame
};

const V = {
  available: false, configured: false, fps: 0, duration: 0, name: null, caseName: null,
  clipStart: 0, clipEnd: 20, center: 0, mode: 'float', open: false,
  sourceKey: null, seekToken: 0, seekPending: false, fpsSource: null, frameIndex: 0,
  floatRect: null, playbackRate: 1,
};

// ---------- canvas ----------
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const mini = $('minimap');
const mctx = mini.getContext('2d');
let dpr = window.devicePixelRatio || 1;

function resizeCanvas(){
  const vp = $('viewport');
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(vp.clientWidth * dpr);
  canvas.height = Math.floor(vp.clientHeight * dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  mini.width = mini.clientWidth * dpr;
  mini.height = mini.clientHeight * dpr;
  mctx.setTransform(dpr,0,0,dpr,0,0);
  render();
}

// The viewport changes size for four reasons now: window resize, panel collapse,
// gutter drag and fullscreen. Keep whatever image point was at the centre at the
// centre, so zoom and position survive the change instead of drifting.
let lastVp=[0,0];
function onViewportResize(){
  const vp=$('viewport');
  const nw=vp.clientWidth, nh=vp.clientHeight;
  if(S.W && S.scale && lastVp[0] && lastVp[1] && (nw!==lastVp[0]||nh!==lastVp[1])){
    const ix=(lastVp[0]/2 - S.panX)/S.scale, iy=(lastVp[1]/2 - S.panY)/S.scale;
    S.panX = nw/2 - ix*S.scale;
    S.panY = nh/2 - iy*S.scale;
  }
  lastVp=[nw,nh];
  resizeCanvas();
}
if(window.ResizeObserver) new ResizeObserver(onViewportResize).observe($('viewport'));
window.addEventListener('resize', onViewportResize);

// ---------- helpers ----------
function toImg(sx, sy){ return [ (sx - S.panX)/S.scale, (sy - S.panY)/S.scale ]; }
function vpSize(){ const vp=$('viewport'); return [vp.clientWidth, vp.clientHeight]; }
function clampi(v,a,b){ return Math.max(a, Math.min(b, v)); }

function hslToRgb(h,s,l){
  h/=360; s/=100; l/=100;
  if(s===0){const v=Math.round(l*255); return [v,v,v];}
  const hue2=(p,q,t)=>{ if(t<0)t+=1; if(t>1)t-=1;
    if(t<1/6)return p+(q-p)*6*t; if(t<1/2)return q; if(t<2/3)return p+(q-p)*(2/3-t)*6; return p; };
  const q = l<0.5 ? l*(1+s) : l+s-l*s; const p=2*l-q;
  return [Math.round(hue2(p,q,h+1/3)*255), Math.round(hue2(p,q,h)*255), Math.round(hue2(p,q,h-1/3)*255)];
}
function colorForObj(objId){ return hslToRgb((objId*137.5)%360, 65, 60); }
function classNameForId(cid){
  for(const [n,i] of Object.entries(S.classMap)) if(i===cid) return n;
  return 'class '+cid;
}
function nameForObjId(objId){
  const cid = objId>999? Math.floor(objId/1000): objId;
  const suffix = objId%1000;
  return classNameForId(cid) + (suffix? ' '+suffix : '');
}

function toast(msg, kind){
  if(Array.isArray(msg)) msg = msg.map(e=> e&&e.msg? `${e.msg}${e.loc?' ('+e.loc.join('.')+')':''}` : String(e)).join('; ');
  else if(msg && typeof msg==='object') msg = msg.msg || JSON.stringify(msg);
  const t=$('toast'); t.textContent=msg; t.className='toast '+(kind||'');
  t.classList.remove('hidden');
  clearTimeout(t._t); t._t=setTimeout(()=>t.classList.add('hidden'), 2600);
}
function showOverlay(text){ $('overlayText').textContent=text||'Working…'; $('overlay').classList.remove('hidden'); }
function hideOverlay(){ $('overlay').classList.add('hidden'); }
// styled confirm dialog (replaces native confirm) -> Promise<bool>
function uiConfirm(message, opts){
  opts=opts||{};
  return new Promise(resolve=>{
    $('uiDialogTitle').textContent=opts.title||'Please confirm';
    $('uiDialogBody').textContent=message;
    const ok=$('uiDialogOk'), cancel=$('uiDialogCancel'), modal=$('uiDialog');
    ok.textContent=opts.okText||'OK';
    ok.style.cssText = opts.danger? 'background:#7a2a2a;border-color:#7a2a2a;color:#ffdede' : '';
    ok.className='btn '+(opts.danger?'':'btn-accent');
    modal.classList.remove('hidden');
    const done=(v)=>{ modal.classList.add('hidden'); ok.onclick=cancel.onclick=modal.onclick=null; resolve(v); };
    ok.onclick=()=>done(true); cancel.onclick=()=>done(false);
    modal.onclick=e=>{ if(e.target.id==='uiDialog') done(false); };
  });
}
// styled text-input dialog -> Promise<string|null>
function uiPrompt(message, opts){
  opts=opts||{};
  return new Promise(resolve=>{
    $('uiDialogTitle').textContent=opts.title||'Enter a value';
    $('uiDialogBody').innerHTML=`<div style="margin-bottom:10px">${message}</div><input id="uiDialogInput" class="path-input" style="width:100%" spellcheck="false" value="${(opts.value||'').replace(/"/g,'&quot;')}"/>`;
    const ok=$('uiDialogOk'), cancel=$('uiDialogCancel'), modal=$('uiDialog');
    ok.textContent=opts.okText||'Create'; ok.className='btn btn-accent'; ok.style.cssText='';
    modal.classList.remove('hidden');
    const inp=$('uiDialogInput'); setTimeout(()=>{ inp.focus(); inp.select(); },30);
    const done=(v)=>{ modal.classList.add('hidden'); ok.onclick=cancel.onclick=modal.onclick=inp.onkeydown=null; resolve(v); };
    ok.onclick=()=>done(inp.value.trim()||null);
    cancel.onclick=()=>done(null);
    inp.onkeydown=e=>{ if(e.key==='Enter'){ e.preventDefault(); done(inp.value.trim()||null); } };
    modal.onclick=e=>{ if(e.target.id==='uiDialog') done(null); };
  });
}

// decode base64 PNG mask -> Uint8Array(W*H) 0/1
function pngB64ToBin(b64){
  return new Promise((resolve)=>{
    const im = new Image();
    im.onload = ()=>{
      const c=document.createElement('canvas'); c.width=S.W; c.height=S.H;
      const cx=c.getContext('2d'); cx.drawImage(im,0,0,S.W,S.H);
      const d=cx.getImageData(0,0,S.W,S.H).data;
      const bin=new Uint8Array(S.W*S.H);
      for(let i=0,p=0;i<bin.length;i++,p+=4) bin[i]= d[p]>127?1:0;
      resolve(bin);
    };
    im.src='data:image/png;base64,'+b64;
  });
}
// encode Uint8Array bin -> base64 PNG
function binToPngB64(bin){
  const c=document.createElement('canvas'); c.width=S.W; c.height=S.H;
  const cx=c.getContext('2d'); const img=cx.createImageData(S.W,S.H); const d=img.data;
  for(let i=0,p=0;i<bin.length;i++,p+=4){ const v=bin[i]?255:0; d[p]=d[p+1]=d[p+2]=v; d[p+3]=255; }
  cx.putImageData(img,0,0);
  return c.toDataURL('image/png').split(',')[1];
}

// ---------- object mask tint (fill + boundary + centroid) ----------
function buildTint(obj){
  const {W,H}=S; const c=document.createElement('canvas'); c.width=W; c.height=H;
  const cx=c.getContext('2d'); const img=cx.createImageData(W,H); const d=img.data;
  const [r,g,b]=obj.color; const bin=obj.bin;
  let sx=0,sy=0,n=0;
  const fillA = S.vis.fill ? 115 : 0;
  const edgeA = S.vis.boundary ? 240 : fillA;
  for(let y=0;y<H;y++){
    for(let x=0;x<W;x++){
      const i=y*W+x;
      if(!bin[i]) continue;
      sx+=x; sy+=y; n++;
      let edge=false;
      if(S.vis.boundary){
        if(x===0||y===0||x===W-1||y===H-1) edge=true;
        else if(!bin[i-1]||!bin[i+1]||!bin[i-W]||!bin[i+W]) edge=true;
      }
      const p=i*4; d[p]=r; d[p+1]=g; d[p+2]=b; d[p+3]= edge?edgeA:fillA;
    }
  }
  cx.putImageData(img,0,0);
  obj.tint=c;
  obj.centroid = n? [sx/n, sy/n] : null;
}
function invalidateTint(obj){ obj.tint=null; obj.flashTint=null; }
function ensureTint(obj){ if(!obj.tint) buildTint(obj); }
function buildFlashTint(obj){
  const {W,H}=S; const c=document.createElement('canvas'); c.width=W; c.height=H;
  const cx=c.getContext('2d'); const img=cx.createImageData(W,H); const d=img.data;
  const [r,g,b]=obj.color; const bin=obj.bin;
  for(let i=0,p=0;i<bin.length;i++,p+=4){
    if(bin[i]){ d[p]=Math.min(255,r+120); d[p+1]=Math.min(255,g+120); d[p+2]=Math.min(255,b+120); d[p+3]=255; }
  }
  cx.putImageData(img,0,0); obj.flashTint=c;
}
function flashObject(id, silent){
  const obj=S.objects.get(id); if(!obj) return;
  if(!obj.bin.some(v=>v)){ if(!silent) toast('No mask on this frame for '+obj.name); return; }
  buildFlashTint(obj);
  S.flash={id, start:performance.now(), dur:500};
  tickFlash();
}
function tickFlash(){
  if(!S.flash) return;
  render();
  if(S.flash) requestAnimationFrame(tickFlash);
}
function tickBoxFlash(){ render(); if(S.boxFlash) requestAnimationFrame(tickBoxFlash); }
function invalidateAllTints(){ for(const o of S.objects.values()) o.tint=null; }

// ---------- render ----------
function render(){
  const [vw,vh]=vpSize();
  ctx.clearRect(0,0,vw,vh);
  if(!S.img){ return; }

  ctx.save();
  ctx.translate(S.panX,S.panY); ctx.scale(S.scale,S.scale);

  // base frame (smooth)
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(S.img,0,0,S.W,S.H);

  // masks (pixelated for crisp edges when zoomed)
  ctx.imageSmoothingEnabled = false;
  if(S.vis.all){
    for(const id of S.order){
      const obj=S.objects.get(id); if(!obj||!obj.visible) continue;
      ensureTint(obj);
      ctx.drawImage(obj.tint,0,0,S.W,S.H);
    }
  }
  ctx.restore();

  // object flash (double-click a button to locate its mask)
  if(S.flash){
    const obj=S.objects.get(S.flash.id);
    const t=(performance.now()-S.flash.start)/S.flash.dur;
    if(!obj || t>=1){ S.flash=null; }
    else {
      if(!obj.flashTint) buildFlashTint(obj);
      const pulse=Math.sin(t*Math.PI);   // single highlight: 0 -> 1 -> 0
      ctx.save();
      ctx.translate(S.panX,S.panY); ctx.scale(S.scale,S.scale);
      ctx.imageSmoothingEnabled=false; ctx.globalAlpha=0.15+0.75*pulse;
      ctx.drawImage(obj.flashTint,0,0,S.W,S.H);
      ctx.restore(); ctx.globalAlpha=1;
    }
  }

  if(S.vis.all){
    // boxes — persistent only when the Boxes toggle is on
    if(S.vis.boxes){
      for(const [id,box] of S.boxes){
        const obj=S.objects.get(id); if(!obj||!obj.visible) continue;
        drawBoxScreen(box, id===S.currentId? '#ffffff' : `rgb(${obj.color.join(',')})`);
      }
    }
    // live drag box + brief post-draw flash (shown regardless of toggle)
    if(S.tempBox) drawBoxScreen(S.tempBox, '#37e5a0');
    if(S.boxFlash){
      const t=(performance.now()-S.boxFlash.start)/S.boxFlash.dur;
      if(t>=1){ S.boxFlash=null; } else { drawBoxScreen(S.boxFlash.box, S.boxFlash.color); }
    }
    // points
    if(S.vis.points){
      for(const [id,pts] of S.points){
        const obj=S.objects.get(id); if(!obj||!obj.visible) continue;
        for(const pt of pts) drawPointScreen(pt, obj.color);
      }
    }
    // track ids
    if(S.vis.ids){
      for(const id of S.order){
        const obj=S.objects.get(id); if(!obj||!obj.visible||!obj.centroid) continue;
        const [cx,cy]=obj.centroid; const sx=cx*S.scale+S.panX, sy=cy*S.scale+S.panY;
        ctx.font='600 12px Inter, system-ui'; ctx.textAlign='center';
        ctx.fillStyle='rgba(0,0,0,.55)'; ctx.fillText(`${obj.name} #${id}`, sx+1, sy+1);
        ctx.fillStyle=`rgb(${obj.color.join(',')})`; ctx.fillText(`${obj.name} #${id}`, sx, sy);
      }
    }
  }

  // brush cursor
  if(S.brush && S.currentId!=null && lastMouse){
    const rad=(S.brushSize/2)*S.scale;
    ctx.beginPath(); ctx.arc(lastMouse[0],lastMouse[1],rad,0,Math.PI*2);
    ctx.strokeStyle='rgba(255,255,0,.9)'; ctx.lineWidth=1; ctx.stroke();
  }
  renderMini();
}
function drawBoxScreen(box,color){
  const x=box[0]*S.scale+S.panX, y=box[1]*S.scale+S.panY;
  const w=(box[2]-box[0])*S.scale, h=(box[3]-box[1])*S.scale;
  ctx.strokeStyle=color; ctx.lineWidth=2; ctx.strokeRect(x,y,w,h);
}
function drawPointScreen(pt,color){
  const x=pt.x*S.scale+S.panX, y=pt.y*S.scale+S.panY;
  ctx.lineWidth=3;
  if(pt.label===1){ ctx.strokeStyle=`rgb(${color.join(',')})`;
    ctx.beginPath(); ctx.moveTo(x-6,y); ctx.lineTo(x+6,y); ctx.moveTo(x,y-6); ctx.lineTo(x,y+6); ctx.stroke();
  } else { ctx.strokeStyle='#ff5d5d';
    ctx.beginPath(); ctx.moveTo(x-6,y); ctx.lineTo(x+6,y); ctx.stroke(); }
}

// ---------- minimap ----------
function renderMini(){
  const mw=mini.clientWidth, mh=mini.clientHeight;
  mctx.clearRect(0,0,mw,mh);
  if(!S.img) return;
  const s=Math.min(mw/S.W, mh/S.H); const iw=S.W*s, ih=S.H*s;
  const ox=(mw-iw)/2, oy=(mh-ih)/2;
  mctx.imageSmoothingEnabled=true; mctx.drawImage(S.img,ox,oy,iw,ih);
  mini._map={s,ox,oy};
  // viewport rect (what part of the image is visible)
  const [vw,vh]=vpSize();
  const vx0=(-S.panX)/S.scale, vy0=(-S.panY)/S.scale;
  const vx1=(vw-S.panX)/S.scale, vy1=(vh-S.panY)/S.scale;
  const rx=ox+clampi(vx0,0,S.W)*s, ry=oy+clampi(vy0,0,S.H)*s;
  const rw=(clampi(vx1,0,S.W)-clampi(vx0,0,S.W))*s, rh=(clampi(vy1,0,S.H)-clampi(vy0,0,S.H))*s;
  mctx.strokeStyle='#37e5a0'; mctx.lineWidth=1.5; mctx.strokeRect(rx,ry,rw,rh);
  mctx.fillStyle='rgba(55,229,160,.12)'; mctx.fillRect(rx,ry,rw,rh);
}
function miniToImage(mx,my){
  const m=mini._map; if(!m) return null;
  return [ (mx-m.ox)/m.s, (my-m.oy)/m.s ];
}

// ---------- view: zoom / pan / fit ----------
function setZoom(newScale, cx, cy){
  const [vw,vh]=vpSize();
  if(cx==null){ cx=vw/2; cy=vh/2; }
  newScale=clampi(newScale, 0.1, 8);
  const [ix,iy]=toImg(cx,cy);
  S.scale=newScale; S.panX=cx-ix*S.scale; S.panY=cy-iy*S.scale;
  syncZoomUI(); render();
}
function fitView(){
  const [vw,vh]=vpSize(); if(!S.W) return;
  const s=Math.min((vw-24)/S.W,(vh-24)/S.H);
  S.scale=s; S.panX=(vw-S.W*s)/2; S.panY=(vh-S.H*s)/2;
  syncZoomUI(); render();
}
// Fit AFTER the browser has laid the viewport out. Calling fitView() synchronously
// at the end of a load measures a viewport that has not settled yet (panels, fonts,
// scrollbars), which leaves the image scaled for a narrower stage and off-centre.
function fitViewSoon(){
  requestAnimationFrame(()=>{
    resizeCanvas();
    fitView();
    lastVp=[$('viewport').clientWidth, $('viewport').clientHeight];
    requestAnimationFrame(()=>{ fitView(); lastVp=[$('viewport').clientWidth,$('viewport').clientHeight]; });
  });
}
function syncZoomUI(){
  $('zoomSlider').value=Math.round(S.scale*100);
  $('zoomLabel').textContent=Math.round(S.scale*100)+'%';
}

// first mask import of a case turns propagation off; later ones don't.
// Declared here because the undo snapshots capture and restore it.
let importedThisSession=false;

// ---------- undo ----------
// Two kinds of history entry:
//   'bins' — a brush stroke / prediction / post-process: mask pixels only (cheap, frequent)
//   'full' — a structural change such as a replace-import: the whole object list, the
//            prompts, this frame's SAM2-raw record and the propagation toggle.
function pushHistory(entry){
  S.history.push(entry);
  if(S.history.length>S.maxHistory) S.history.shift();
}
function snapshot(){
  const bins=new Map();
  for(const [id,obj] of S.objects) bins.set(id, obj.bin? obj.bin.slice(0):null);
  pushHistory({kind:'bins', frame:S.idx, bins});
}
// Capture without pushing, so a failed operation can discard it instead of
// leaving a no-op entry on the stack.
function captureFull(){
  const objects=[];
  for(const id of S.order){
    const o=S.objects.get(id); if(!o) continue;
    objects.push({id:o.id, classId:o.classId, name:o.name, color:o.color.slice(0),
                  visible:o.visible, bin:o.bin? o.bin.slice(0):null});
  }
  const raw=S.rawMasks.get(S.idx);
  return {
    kind:'full', frame:S.idx,
    objects, order:S.order.slice(0), currentId:S.currentId,
    points:new Map([...S.points].map(([k,v])=>[k, v.map(p=>({...p}))])),
    boxes: new Map([...S.boxes].map(([k,v])=>[k, v.slice(0)])),
    raw: raw? new Map([...raw].map(([k,v])=>[k, {...v, bin:v.bin? v.bin.slice(0):null}])) : null,
    propagation:S.propagation, imported:importedThisSession, dirty:S.dirty,
  };
}
function restoreFull(snap){
  S.objects.clear();
  for(const o of snap.objects){
    S.objects.set(o.id, {id:o.id, classId:o.classId, name:o.name, color:o.color.slice(0),
      bin:o.bin? o.bin.slice(0): new Uint8Array(S.W*S.H),
      tint:null, visible:o.visible, centroid:null});
  }
  S.order=snap.order.filter(id=>S.objects.has(id));
  S.currentId = S.objects.has(snap.currentId)? snap.currentId : (S.order[0] ?? null);
  S.points=new Map([...snap.points].map(([k,v])=>[k, v.map(p=>({...p}))]));
  S.boxes =new Map([...snap.boxes ].map(([k,v])=>[k, v.slice(0)]));
  if(snap.raw) S.rawMasks.set(snap.frame, new Map([...snap.raw].map(([k,v])=>[k, {...v, bin:v.bin? v.bin.slice(0):null}])));
  else S.rawMasks.delete(snap.frame);
  S.propagation=snap.propagation;
  $('propBtn').textContent='Propagation: '+(S.propagation?'ON':'OFF');
  $('propBtn').classList.toggle('on', S.propagation);
  importedThisSession=snap.imported;
  S.dirty=snap.dirty;
  rebuildObjList();
}
function undo(){
  if(S.history.length===0){ toast('Nothing to undo'); return; }
  const snap=S.history.pop();
  if(snap.kind==='full'){
    restoreFull(snap); render();
    toast('Import undone — frame restored','ok');
    return;
  }
  for(const [id,bin] of snap.bins){
    const obj=S.objects.get(id); if(!obj) continue;
    obj.bin= bin? bin.slice(0): new Uint8Array(S.W*S.H); invalidateTint(obj);
  }
  render();
}

// ---------- objects ----------
function addObject(classId, name){
  // unique obj id = classId*1000 + suffix (matches desktop tool)
  const suffix=[...S.objects.keys()].filter(id=>Math.floor(id/1000)===classId || id===classId).length;
  let id=classId*1000+suffix; while(S.objects.has(id)) id++;
  const obj={id, classId, name:(suffix>0?`${name}_${suffix}`:name),
             color:colorForObj(id), bin:new Uint8Array(S.W*S.H), tint:null, visible:true, centroid:null};
  S.objects.set(id,obj); S.order.push(id);
  rebuildObjList(); selectObject(id);
  return obj;
}
function ensureObject(id, classId, name, color){
  if(S.objects.has(id)) return S.objects.get(id);
  const obj={id, classId, name, color:color||colorForObj(id),
             bin:new Uint8Array(S.W*S.H), tint:null, visible:true, centroid:null};
  S.objects.set(id,obj); S.order.push(id); rebuildObjList();
  return obj;
}
function deleteObject(id){
  S.objects.delete(id); S.order=S.order.filter(x=>x!==id);
  S.points.delete(id); S.boxes.delete(id);
  if(S.currentId===id) S.currentId = S.order[0]??null;
  S.dirty=true; rebuildObjList(); render();
}
function selectObject(id){
  S.currentId=id;
  document.querySelectorAll('.obj-item').forEach(el=>el.classList.toggle('active', +el.dataset.id===id));
  if(S.brush) canvas.style.cursor='none';
}
function cycleObject(dir){
  if(S.order.length===0) return;
  let i=S.order.indexOf(S.currentId); i=(i+dir+S.order.length)%S.order.length;
  selectObject(S.order[i]); flashObject(S.order[i], true);
}
function rebuildObjList(){
  const box=$('objList'); box.innerHTML='';
  for(const id of S.order){
    const obj=S.objects.get(id);
    const hasMask = obj.bin && obj.bin.some(v=>v);
    const greyed = !obj.visible || !hasMask;   // grey when hidden OR no mask on this frame
    const el=document.createElement('div');
    el.className='obj-item'+(id===S.currentId?' active':'')+(greyed?' hidden-mask':'');
    el.dataset.id=id;
    el.innerHTML=`<span class="obj-dot" style="background:rgb(${obj.color.join(',')})"></span>
      <span class="obj-name">${obj.name}</span>
      <span class="obj-eye" title="Toggle visibility">${obj.visible?'👁':'—'}</span>
      <span class="obj-del" title="Delete">✕</span>`;
    el.addEventListener('click',(e)=>{
      if(e.target.classList.contains('obj-eye')){ obj.visible=!obj.visible; rebuildObjList(); render(); return; }
      if(e.target.classList.contains('obj-del')){ deleteObject(id); return; }
      selectObject(id);
    });
    el.addEventListener('dblclick',(e)=>{
      if(e.target.classList.contains('obj-eye')||e.target.classList.contains('obj-del')) return;
      selectObject(id); flashObject(id);
    });
    box.appendChild(el);
  }
}

// ---------- prediction ----------
async function runPredict(){
  const id=S.currentId; if(id==null) return;
  const pts=(S.points.get(id)||[]).map(p=>[p.x,p.y]);
  const labs=(S.points.get(id)||[]).map(p=>p.label);
  const box=S.boxes.get(id)||null;
  if(pts.length===0 && !box) return;
  const {ok,j}=await API.post('/api/predict',{frame_idx:S.idx, obj_id:id, points:pts, labels:labs, box});
  if(!ok){ toast(j.detail||'predict failed','err'); return; }
  const bin=await pngB64ToBin(j.mask);
  const obj=S.objects.get(id); snapshot(); obj.bin=bin; invalidateTint(obj);
  captureRaw(id, bin, 'prompt', true);   // SAM2's first-prompt proposal, frozen (later prompts are human-guided)
  S.dirty=true; rebuildObjList(); render();
}

// ---------- brush ----------
function paintCircle(ix,iy,add){
  const obj=S.objects.get(S.currentId); if(!obj) return;
  const r=Math.floor(S.brushSize/2); const {W,H}=S;
  const x0=clampi(Math.floor(ix-r),0,W-1), x1=clampi(Math.ceil(ix+r),0,W-1);
  const y0=clampi(Math.floor(iy-r),0,H-1), y1=clampi(Math.ceil(iy+r),0,H-1);
  for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++){
    const dx=x-ix, dy=y-iy; if(dx*dx+dy*dy<=r*r) obj.bin[y*W+x]= add?1:0;
  }
  invalidateTint(obj);
}
function brushLine(x0,y0,x1,y1,add){
  const dist=Math.max(1,Math.hypot(x1-x0,y1-y0)); const steps=Math.max(2,Math.round(dist));
  for(let i=0;i<steps;i++){ const t=i/(steps-1); paintCircle(x0+t*(x1-x0), y0+t*(y1-y0), add); }
}

// ---------- post-processing ----------
async function applyPP(op){
  const obj=S.objects.get(S.currentId); if(!obj){ toast('Select an object'); return; }
  lockRaw(obj.id);   // freeze SAM2-raw before this correction
  const body={op, mask:binToPngB64(obj.bin), kernel: op==='gaussian'?S.gauss:S.morph, n:S.comp};
  const {ok,j}=await API.post('/api/postprocess',body);
  if(!ok){ toast('postprocess failed','err'); return; }
  snapshot(); obj.bin=await pngB64ToBin(j.mask); invalidateTint(obj); S.dirty=true; render();
  toast(op+' applied','ok');
}

// ---------- raw-mask capture (for SAM2-initial vs human-final Dice) ----------
function rawFrame(idx){ if(!S.rawMasks.has(idx)) S.rawMasks.set(idx,new Map()); return S.rawMasks.get(idx); }
function captureRaw(objId, bin, kind, lock){
  const m=rawFrame(S.idx); const cur=m.get(objId);
  if(cur && cur.locked) return;                 // frozen once a human edit began
  const obj=S.objects.get(objId);
  m.set(objId, {bin:bin.slice(0), kind, classId: obj? (obj.id>999?Math.floor(obj.id/1000):obj.id):objId, locked:!!lock});
}
function lockRaw(objId){
  const m=rawFrame(S.idx); const cur=m.get(objId);
  if(cur){ cur.locked=true; }
  else {  // human edited a mask SAM2 never produced -> raw is empty (max human work)
    const obj=S.objects.get(objId);
    m.set(objId, {bin:new Uint8Array(S.W*S.H), kind:'prompt',
                  classId: obj? (obj.id>999?Math.floor(obj.id/1000):obj.id):objId, locked:true});
  }
}
function clearRawAfter(frame){ for(const f of [...S.rawMasks.keys()]) if(f>frame) S.rawMasks.delete(f); }

// ---------- frames ----------
function commitFrame(idx){
  if(idx==null || idx<0 || S.objects.size===0) return;
  const m=new Map();
  for(const [id,obj] of S.objects) m.set(id, obj.bin.slice(0));
  S.frameMasks.set(idx, m);
}
function restoreFrame(idx){
  const m=S.frameMasks.get(idx)||new Map();
  // S.objects is global across frames, so a replace-import on a later frame would
  // otherwise erase this frame's objects too — rebuild any that this frame still has.
  for(const id of m.keys()){
    if(!S.objects.has(id)) ensureObject(id, id>999?Math.floor(id/1000):id, nameForObjId(id));
  }
  for(const [id,obj] of S.objects){
    const bin=m.get(id);
    obj.bin=(bin && bin.length===S.W*S.H)? bin.slice(0): new Uint8Array(S.W*S.H);
    invalidateTint(obj);
  }
}
function clearFrameMasks(){
  for(const obj of S.objects.values()){ obj.bin=new Uint8Array(S.W*S.H); invalidateTint(obj); }
}
// show a real progress bar for slow propagation jumps (polls the server)
function startPropProgress(){
  let shown=false, poll=null;
  const t=setTimeout(()=>{
    shown=true; $('overlayBar').classList.remove('hidden'); showOverlay('Propagating…');
    poll=setInterval(async ()=>{
      try{ const p=await API.get('/api/propagate/progress');
        if(p.active && p.target>p.start){
          const frac=Math.max(0,Math.min(1,(p.current-p.start)/(p.target-p.start)));
          $('overlayBarFill').style.width=(frac*100).toFixed(1)+'%';
          $('overlayText').textContent=`Propagating… frame ${p.current+1} / ${p.target+1}`;
        }
      }catch(_){}
    }, 180);
  }, 250);   // only appears if the jump actually takes a moment
  return ()=>{ clearTimeout(t); if(poll) clearInterval(poll);
    if(shown){ $('overlayBar').classList.add('hidden'); $('overlayBarFill').style.width='0%'; hideOverlay(); } };
}
// reseed the generator from `idx` with all current visible masks (carries new/edited objects forward)
async function reseedFrom(idx){
  const objects=[];
  for(const id of S.order){ const o=S.objects.get(id); if(o.visible && o.bin.some(v=>v)) objects.push({obj_id:id, mask:binToPngB64(o.bin)}); }
  if(!objects.length) return false;
  await API.post('/api/propagate/reseed',{frame_idx:idx, objects});
  for(const f of [...S.frameMasks.keys()]) if(f>idx) S.frameMasks.delete(f);
  return true;
}
async function propagateInto(idx){
  clearFrameMasks();   // hard-clear every object first, so no previous-frame mask can linger
  const stop=startPropProgress();
  const {ok,j}=await API.post('/api/propagate/frame',{frame_idx:idx});
  stop();
  if(ok && j.available && j.masks.length){
    for(const mk of j.masks){
      const obj=ensureObject(mk.obj_id, (mk.obj_id>999?Math.floor(mk.obj_id/1000):mk.obj_id), nameForObjId(mk.obj_id));
      obj.bin=await pngB64ToBin(mk.mask); invalidateTint(obj);
      captureRaw(obj.id, obj.bin, 'propagation', true);   // pure SAM2 tracking output, frozen
    }
  }
  commitFrame(idx);   // cache so moving back later restores this, not a re-propagation
}

async function loadFrame(newIdx, opts={}){
  newIdx=clampi(newIdx,0,S.count-1);
  const oldIdx=S.idx;
  const wasDirty=S.dirty;   // did the user add/edit masks on the frame we're leaving?
  if(newIdx===oldIdx && !opts.force) return;
  if(!opts.skipCommit) commitFrame(oldIdx);

  // load image + meta
  const meta=await API.get('/api/frame_meta/'+newIdx);
  S.W=meta.width; S.H=meta.height;
  await new Promise(res=>{ const im=new Image(); im.onload=()=>{S.img=im;res();}; im.src='/api/frame_image/'+newIdx+'?t='+Date.now(); });
  S.idx=newIdx;
  S.points.clear(); S.boxes.clear(); S.history=[]; S.flash=null;
  $('emptyHint').classList.add('hidden');
  $('frameName').textContent=meta.name;
  $('position').textContent=`${S.idx+1} / ${S.count}`;
  $('frameSlider').value=S.idx;
  if(V.open) positionContextVideo(S.idx,false);

  const forward = newIdx > oldIdx;
  const firstVisit = !S.frameMasks.has(newIdx);
  if(S.frameMasks.has(newIdx)){
    // already visited (or already propagated) — show the work that's there
    restoreFrame(newIdx);
  } else if(forward && S.propagation && S.sam2 && !opts.noProp){
    // moving forward into a new frame — propagate (clears old masks first).
    // if the frame we left had edits (new/changed masks), reseed from it first so they carry forward.
    if(wasDirty && !S.refineSrc){ await reseedFrom(oldIdx); }
    await propagateInto(newIdx);
  } else {
    // moving back into an un-annotated frame, or propagation off — blank
    clearFrameMasks();
  }
  // refine mode: on first visit to a frame, seed with the annotator's saved mask
  if(S.refineSrc && firstVisit){ await importMaskInto(S.refineSrc, true); }
  rebuildObjList(); render();
  S.dirty=false;   // arriving at a frame is a clean slate until the user edits
}

// ---------- save ----------
let saveConfigured=false;
function collectSaveObjects(){
  const objects=[];
  for(const id of S.order){
    const obj=S.objects.get(id); if(!obj.visible) continue;
    if(!obj.bin.some(v=>v)) continue;
    const classId = id>999? Math.floor(id/1000): id;
    objects.push({class_id:classId, mask:binToPngB64(obj.bin)});
  }
  return objects;
}
async function saveMasks(){
  if(!S.count){ toast('Open a folder first'); return; }
  if(collectSaveObjects().length===0){ toast('No visible masks to save','err'); return; }
  // first save: let the user confirm/choose PNG then YOLO output folders
  if(!saveConfigured){
    const pngOnly=$('exportPngOnly').checked;
    openBrowser({title:'Choose PNG output folder', start:$('pngDir').value||S.defaultPath, onSelect:(p)=>{
      if(p) $('pngDir').value=p;
      if(pngOnly){ saveConfigured=true; doSave(); return; }
      openBrowser({title:'Choose YOLO output folder', start:$('yoloDir').value||S.defaultPath, onSelect:(p2)=>{
        if(p2) $('yoloDir').value=p2;
        saveConfigured=true; doSave();
      }});
    }});
    return;
  }
  doSave();
}
async function doSave(){
  const pngDir=$('pngDir').value.trim(), yoloDir=$('yoloDir').value.trim();
  const pngOnly=$('exportPngOnly').checked;
  if(!pngDir || (!pngOnly && !yoloDir)){ toast(pngOnly?'Set PNG output dir':'Set PNG + YOLO output dirs','err'); saveConfigured=false; return; }
  const objects=collectSaveObjects();
  // SAM2-raw for this frame (automatic) -> sibling <annotator>_sam dir
  let raw_objects=[], sam_dir='';
  if($('exportSamRaw').checked){
    const rawMap=S.rawMasks.get(S.idx);
    if(rawMap){ for(const [,r] of rawMap){ if(r.bin.some(v=>v)) raw_objects.push({class_id:r.classId, mask:binToPngB64(r.bin)}); } }
    if(raw_objects.length) sam_dir=deriveSamDir(pngDir);
  }
  showOverlay('Saving masks…');
  const {ok,j}=await API.post('/api/save',{frame_idx:S.idx, png_dir:pngDir, yolo_dir:yoloDir||pngDir, objects, yolo:!pngOnly, raw_objects, sam_dir});
  hideOverlay();
  if(!ok){ toast(j.detail||'save failed','err'); return; }
  S.dirty=false;
  flashScreen();
  const samNote = j.sam_path? ' + SAM-raw' : '';
  const yoloDetail = (j.yolo_err||'').replace(/\s+/g,' ').trim();
  const label = pngOnly? `Saved ✓  ${S.frames[S.idx]}  (PNG${samNote})`
              : (j.yolo_ok? `Saved ✓  ${S.frames[S.idx]}  (PNG + YOLO${samNote})`
                 : `Saved PNG (YOLO failed${yoloDetail?`: ${yoloDetail.slice(0,180)}`:''})`);
  toast(label, (pngOnly||j.yolo_ok)?'ok':'err');
  if(pendingFrame!=null){ const t=pendingFrame; pendingFrame=null; loadFrame(t); }
}
function deriveSamDir(pngDir){
  const segs=pngDir.replace(/\/+$/,'').split('/');
  const user=(S.user||'').trim();
  // 1) if the <user> segment is present, make its _sam sibling (…/Qixiang/… -> …/Qixiang_sam/…)
  if(user){ for(let i=segs.length-1;i>=0;i--){ if(segs[i]===user){ segs[i]=user+'_sam'; return segs.join('/'); } } }
  // 2) new layout <user>/<case>/masks -> _sam on the user level (segs[-3])
  if((segs[segs.length-1]==='masks'||segs[segs.length-1]==='labels') && segs.length>=3){ segs[segs.length-3]+='_sam'; return segs.join('/'); }
  // 3) flat <annotator>/<case> -> _sam on the annotator level (segs[-2])
  if(segs.length>=2){ segs[segs.length-2]+='_sam'; return segs.join('/'); }
  return pngDir.replace(/\/+$/,'')+'_sam';
}
function flashScreen(){
  const f=$('saveFlash'); if(!f) return;
  f.classList.remove('run'); void f.offsetWidth; f.classList.add('run');
}

// ---------- context video ----------
const contextVideo=$('contextVideo');
const VIDEO_PLAYBACK_RATES=[.5,1,1.5,2];
function setVideoPlaybackRate(value, persist=true){
  const rate=Number(value);
  V.playbackRate=VIDEO_PLAYBACK_RATES.includes(rate)?rate:1;
  contextVideo.defaultPlaybackRate=V.playbackRate;
  contextVideo.playbackRate=V.playbackRate;
  $('videoSpeed').value=String(V.playbackRate);
  if(persist){ try{ localStorage.setItem('issas.videoPlaybackRate',String(V.playbackRate)); }catch(_){} }
}
try{ setVideoPlaybackRate(localStorage.getItem('issas.videoPlaybackRate'),false); }
catch(_){ setVideoPlaybackRate(1,false); }
function videoTime(seconds){
  seconds=Math.max(0, Number(seconds)||0);
  const whole=Math.floor(seconds), h=Math.floor(whole/3600), m=Math.floor((whole%3600)/60), s=whole%60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function frameIdAt(index){
  const name=S.frames[index]||'';
  const stem=name.replace(/\.[^.]+$/,'');
  const parts=stem.match(/\d+/g);
  return parts&&parts.length? parseInt(parts[parts.length-1],10) : index;
}
function videoCenterAt(index){ return V.fps>0 ? frameIdAt(index)/V.fps : 0; }
function applyVideoStatus(j){
  j=j||{};
  V.configured=!!j.configured; V.available=!!j.available;
  V.fps=Number(j.fps)>0?Number(j.fps):0; V.fpsSource=j.fps_source||null; V.duration=Number(j.duration)||0;
  V.name=j.name||null; V.caseName=j.case||null;
  $('videoFps').value=V.fps?V.fps.toFixed(3):'';
  const badge=$('videoSourceBadge'), info=$('videoSourceInfo');
  badge.classList.toggle('ready',V.available); badge.classList.toggle('missing',V.configured&&!V.available);
  badge.textContent=V.available?'ready':(V.configured?'no match':'not set');
  if(j.directory && !$('videoPath').value) $('videoPath').value=j.directory;
  const playbackFps=Number(j.playback_fps)>0?Number(j.playback_fps):V.fps;
  const fpsNote=V.fpsSource==='unavailable'?' (unable to detect)':(V.fpsSource==='source-video'?' (source video)':' (auto)');
  info.textContent=V.available&&V.fps?`${j.name} | ${V.fps.toFixed(3)} FPS${fpsNote}`
    :(V.available?`${j.name} | FPS unavailable`:(j.expected?`Waiting for ${j.expected}`:'Matches <case>.mp4'));
  if(V.available&&V.fpsSource==='source-video'&&playbackFps!==V.fps){
    info.textContent+=` | playback ${playbackFps.toFixed(3)} FPS`;
  }
  info.title=info.textContent;
  $('videoOpen').disabled=!V.available||!V.fps||!S.count;
  if(!V.available){ closeContextVideo(); contextVideo.removeAttribute('src'); V.sourceKey=null; return; }
  const key=`${j.directory||''}|${j.name||''}`;
  if(V.sourceKey!==key){
    V.seekToken++; V.seekPending=false;
    V.sourceKey=key;
    contextVideo.src='/api/video/file?key='+encodeURIComponent(key);
    contextVideo.load();
    setVideoPlaybackRate(V.playbackRate,false);
  }
}
async function configureVideoFolder(){
  const path=$('videoPath').value.trim();
  if(!path){ toast('Enter a video folder path','err'); return; }
  // FPS is always read from the matched video's metadata; never reuse a case
  // specific or browser-cached value.
  const {ok,j}=await API.post('/api/video/config',{path,fps:null});
  if(!ok){ toast(j.detail||'video folder could not be opened','err'); return; }
  try{ localStorage.setItem('issas.videoPath',path); localStorage.removeItem('issas.videoFps'); }catch(_){}
  applyVideoStatus(j);
  toast(j.available?`Matched ${j.name}`:`Folder set; ${j.expected||'case video'} was not found`,j.available?'ok':'err');
}
function rememberFloatRect(){
  if(V.mode!=='float'||!V.open) return;
  const rect=$('videoWindow').getBoundingClientRect();
  V.floatRect={left:rect.left,top:rect.top,width:rect.width,height:rect.height};
}
function restoreFloatRect(){
  const win=$('videoWindow'), saved=V.floatRect;
  if(!saved){ win.style.removeProperty('left'); win.style.removeProperty('width'); win.style.removeProperty('height'); win.style.removeProperty('right'); return; }
  const width=Math.min(saved.width,Math.max(280,window.innerWidth-24));
  const height=Math.min(saved.height,Math.max(220,window.innerHeight-70));
  const left=Math.max(0,Math.min(window.innerWidth-width,saved.left));
  const top=Math.max(54,Math.min(window.innerHeight-height,saved.top));
  Object.assign(win.style,{left:left+'px',top:top+'px',right:'auto',width:width+'px',height:height+'px'});
}
function clearDockedVideoGeometry(){
  const win=$('videoWindow');
  for(const prop of ['left','right','top','bottom','width','height']) win.style.removeProperty(prop);
}
function setVideoMode(mode){
  if(!['float','split','main'].includes(mode)) mode='float';
  if(V.mode==='float'&&mode!=='float') rememberFloatRect();
  V.mode=mode;
  const win=$('videoWindow'), stage=win.closest('.stage');
  win.classList.remove('mode-float','mode-split','mode-main'); win.classList.add('mode-'+mode);
  if(mode==='float') requestAnimationFrame(restoreFloatRect); else clearDockedVideoGeometry();
  stage.classList.toggle('video-split',mode==='split'&&V.open);
  stage.classList.toggle('video-main',mode==='main'&&V.open);
  syncVideoSplitDirection();
  document.querySelectorAll('.video-mode').forEach(b=>b.classList.toggle('on',b.dataset.videoMode===mode));
  requestAnimationFrame(resizeCanvas); setTimeout(resizeCanvas,80);
}
function syncVideoSplitDirection(){
  const stage=$('videoWindow').closest('.stage');
  stage.classList.toggle('video-narrow',V.open&&V.mode==='split'&&stage.clientWidth<720);
}
function closeContextVideo(){
  V.open=false; V.seekToken++; V.seekPending=false; contextVideo.pause();
  $('videoLoading').classList.add('hidden');
  const win=$('videoWindow'); win.classList.add('hidden');
  const stage=win.closest('.stage'); stage.classList.remove('video-split','video-main','video-narrow');
  requestAnimationFrame(resizeCanvas);
}
function updateVideoControls(){
  const t=Number(contextVideo.currentTime)||V.clipStart;
  $('videoSeek').value=Math.min(V.clipEnd,Math.max(V.clipStart,t));
  $('videoTime').textContent=`${videoTime(t)} / ${videoTime(V.clipEnd)}`;
  $('videoPlayPause').textContent=contextVideo.paused?'\u25B6':'\u23F8';
}
function updateVideoFrameMark(){
  const span=Math.max(.01,V.clipEnd-V.clipStart);
  const pct=Math.max(0,Math.min(100,(V.center-V.clipStart)/span*100));
  $('videoSeekWrap').style.setProperty('--frame-mark-pos',pct+'%');
  $('videoFrameMark').title=`Observed frame: ${S.frames[V.frameIndex]||'frame'} at ${videoTime(V.center)}`;
}
function waitForVideoMetadata(token){
  if(contextVideo.readyState>=1 && Number.isFinite(contextVideo.duration)) return Promise.resolve(true);
  return new Promise(resolve=>{
    let timer=null;
    const done=ok=>{
      contextVideo.removeEventListener('loadedmetadata',loaded);
      contextVideo.removeEventListener('error',failed);
      if(timer) clearTimeout(timer);
      resolve(ok&&token===V.seekToken);
    };
    const loaded=()=>done(true), failed=()=>done(false);
    contextVideo.addEventListener('loadedmetadata',loaded);
    contextVideo.addEventListener('error',failed);
    timer=setTimeout(()=>done(false),12000);
  });
}
function waitForVideoSeek(target, token){
  return new Promise(resolve=>{
    let timer=null, settled=false;
    const done=ok=>{
      if(settled) return;
      settled=true;
      contextVideo.removeEventListener('seeked',seeked);
      contextVideo.removeEventListener('error',failed);
      if(timer) clearTimeout(timer);
      resolve(ok&&token===V.seekToken);
    };
    const tolerance=Math.max(.25,2/Math.max(1,V.fps));
    const seeked=()=>{ if(Math.abs(contextVideo.currentTime-target)<=tolerance) done(true); };
    const failed=()=>done(false);
    contextVideo.addEventListener('seeked',seeked);
    contextVideo.addEventListener('error',failed);
    timer=setTimeout(()=>done(Math.abs(contextVideo.currentTime-target)<=tolerance),12000);
    try{
      contextVideo.currentTime=target;
      if(!contextVideo.seeking && Math.abs(contextVideo.currentTime-target)<=tolerance){
        requestAnimationFrame(()=>done(true));
      }
    }catch(_){ done(false); }
  });
}
async function seekContextVideo(target, autoplay){
  const token=++V.seekToken;
  V.seekPending=true;
  const loading=$('videoLoading');
  loading.textContent=`Seeking ${videoTime(target)}...`;
  loading.classList.remove('hidden');

  // Calling play inside the original click/right-click gesture preserves Safari's
  // media authorization while metadata and the actual seek complete asynchronously.
  if(autoplay) contextVideo.play().catch(()=>{}); else contextVideo.pause();
  if(!await waitForVideoMetadata(token)){
    if(token===V.seekToken){ V.seekPending=false; contextVideo.pause(); loading.textContent='Video metadata unavailable'; toast('Could not read video metadata','err'); }
    return false;
  }
  if(token!==V.seekToken) return false;

  if(Number.isFinite(contextVideo.duration)) V.duration=contextVideo.duration;
  V.clipEnd=V.duration?Math.min(V.duration,V.center+10):V.center+10;
  if(V.clipEnd<=V.clipStart) V.clipEnd=V.clipStart+.01;
  target=Math.min(V.clipEnd,Math.max(V.clipStart,target));
  $('videoSeek').min=V.clipStart; $('videoSeek').max=V.clipEnd; $('videoSeek').value=target;
  updateVideoFrameMark();

  if(!await waitForVideoSeek(target,token)){
    if(token===V.seekToken){ V.seekPending=false; contextVideo.pause(); loading.textContent='Video seek failed'; toast(`Could not seek video to ${videoTime(target)}`,'err'); }
    return false;
  }
  if(token!==V.seekToken) return false;

  V.seekPending=false;
  loading.textContent='Loading video...';
  loading.classList.toggle('hidden',contextVideo.readyState>=2);
  updateVideoControls();
  if(autoplay) contextVideo.play().catch(()=>toast('Press play to continue','err'));
  return true;
}
function positionContextVideo(index, autoplay){
  V.frameIndex=index;
  V.center=videoCenterAt(index);
  V.clipStart=Math.max(0,V.center-10);
  const duration=V.duration||(Number.isFinite(contextVideo.duration)?contextVideo.duration:0);
  V.clipEnd=duration?Math.min(duration,V.center+10):V.center+10;
  if(V.clipEnd<=V.clipStart) V.clipEnd=V.clipStart+.01;
  $('videoSeek').min=V.clipStart; $('videoSeek').max=V.clipEnd; $('videoSeek').value=V.clipStart;
  $('videoTitle').textContent=V.name||'Context video';
  $('videoSubtitle').textContent=`${S.frames[index]||'frame'} | ${videoTime(V.center)} | -10s / +10s`;
  updateVideoFrameMark();
  updateVideoControls();
  seekContextVideo(V.clipStart,autoplay);
}
function openContextVideo(index=S.idx, autoplay=true){
  if(!V.available){ toast(V.configured?'No matching video for this case':'Set the video folder first','err'); return; }
  V.open=true;
  $('videoWindow').classList.remove('hidden'); setVideoMode(V.mode);
  positionContextVideo(clampi(index,0,S.count-1),autoplay);
}
async function toggleVideoPlay(){
  if(contextVideo.paused){
    if(contextVideo.currentTime>=V.clipEnd-.05){ await seekContextVideo(V.clipStart,true); return; }
    contextVideo.play().catch(()=>{});
  } else contextVideo.pause();
}
function stepVideo(direction){
  contextVideo.pause();
  if(!(V.fps>0)) return;
  const target=Math.min(V.clipEnd,Math.max(V.clipStart,(contextVideo.currentTime||V.center)+direction/V.fps));
  seekContextVideo(target,false);
}
function timelineIndex(e){
  const slider=$('frameSlider'), rect=slider.getBoundingClientRect();
  const ratio=Math.max(0,Math.min(1,(e.clientX-rect.left)/Math.max(1,rect.width)));
  return Math.round(ratio*Math.max(0,S.count-1));
}
function showVideoTimelineTip(e){
  if(!V.available||!S.count) return;
  const idx=timelineIndex(e), center=videoCenterAt(idx), start=Math.max(0,center-10);
  const end=V.duration?Math.min(V.duration,center+10):center+10;
  const tip=$('videoTimelineTip');
  tip.innerHTML=`Frame ${frameIdAt(idx)} &nbsp; <strong>${videoTime(center)}</strong><br>${videoTime(start)} - ${videoTime(end)}`;
  tip.style.left=e.clientX+'px'; tip.style.top=(e.clientY-10)+'px'; tip.classList.remove('hidden');
}

// ============================ EVENTS ============================
let lastMouse=null;

// -- open folder --
$('openBtn').addEventListener('click', async ()=>{
  let path=$('folderPath').value.trim().replace(/\\/g,'/'); if(!path){ toast('Enter a folder path','err'); return; }
  if(await loadFolderIntoEditor(path)){ setDefaultExportDirs(path); S.idx=0; await loadFrame(0,{force:true, noProp:true}); fitViewSoon(); toast('Loaded '+S.count+' frames','ok'); }
});
// core loader — used by Open folder, the file tree, and refine. Fully resets SAM (new case).
async function loadFolderIntoEditor(path){
  path=(path||'').replace(/\\/g,'/'); if(!path){ toast('Enter a folder path','err'); return false; }
  $('folderPath').value=path;
  showOverlay('Loading frames…');
  const {ok,j}=await API.post('/api/open_folder',{path});
  if(!ok){ hideOverlay(); toast(j.detail||'open failed','err'); return false; }
  S.count=j.count; S.frames=j.names; S.sam2=j.sam2_available; S.device=j.device;
  applyVideoStatus(j.video);
  $('modeBadge').textContent = S.sam2? `SAM · ${S.device}` : 'simulation';
  $('modeBadge').className = 'badge '+(S.sam2?'badge-live':'badge-sim');
  $('frameSlider').max=S.count-1;
  S.objects.clear(); S.order=[]; S.currentId=null; S.frameMasks.clear(); S.rawMasks.clear();
  saveConfigured=false; S.dirty=false; pendingFrame=null; S.refineSrc=null;
  // import folders are per-case: unbind them so the new case asks once instead of
  // silently importing the previous case's masks (frame numbering repeats across cases)
  setImportDir('mask', null); setImportDir('prompts', null);
  importedThisSession=false;        // let the first import of the new case set propagation again
  rebuildObjList();
  $('overlayText').textContent = S.sam2? 'Initializing SAM2… (new case — resetting model)' : 'Preparing…';
  await API.post('/api/init',{});   // fresh init_state = SAM memory cleared for the new case
  hideOverlay();
  return true;
}
function setDefaultExportDirs(imagesPath){
  // default save = sibling masks/ + labels/ of the images folder (user can override)
  const parent=imagesPath.replace(/\/+$/,'').replace(/\/[^\/]*$/,'');
  $('pngDir').value=parent+'/masks';
  $('yoloDir').value=parent+'/labels';
}

// -- canvas mouse --
canvas.addEventListener('contextmenu', e=>e.preventDefault());
canvas.addEventListener('mousedown', (e)=>{
  if(!S.img) return;
  const rect=canvas.getBoundingClientRect(); const sx=e.clientX-rect.left, sy=e.clientY-rect.top;
  // pan: middle button or space held
  if(e.button===1 || S.spaceDown){ S.panning=true; S.panStart=[sx,sy,S.panX,S.panY]; canvas.style.cursor='grabbing'; e.preventDefault(); return; }

  const [ix,iy]=toImg(sx,sy);
  if(S.currentId==null){ toast('Add or select an object first'); return; }

  // brush mode
  if(S.brush){
    snapshot(); lockRaw(S.currentId); S.brushing=true; S.brushPositive=(e.button===0);
    paintCircle(ix,iy,S.brushPositive); render(); return;
  }
  // box: ctrl+drag
  if(e.ctrlKey && e.button===0){ S.dragBox=true; S.boxStart=[ix,iy]; S.tempBox=[ix,iy,ix,iy]; return; }
  // points
  if(ix<0||iy<0||ix>=S.W||iy>=S.H) return;
  const label = e.button===2? 0 : 1;
  if(e.button===2){ S.boxes.delete(S.currentId); }  // right-click also clears box (as in desktop)
  if(!S.points.has(S.currentId)) S.points.set(S.currentId,[]);
  S.points.get(S.currentId).push({x:ix,y:iy,label});
  render(); runPredict();
});
canvas.addEventListener('mousemove',(e)=>{
  const rect=canvas.getBoundingClientRect(); const sx=e.clientX-rect.left, sy=e.clientY-rect.top;
  lastMouse=[sx,sy];
  if(S.panning){ S.panX=S.panStart[2]+(sx-S.panStart[0]); S.panY=S.panStart[3]+(sy-S.panStart[1]); render(); return; }
  const [ix,iy]=toImg(sx,sy);
  if(S.brushing){ const [lx,ly]=S._lastImg||[ix,iy]; brushLine(lx,ly,ix,iy,S.brushPositive); S._lastImg=[ix,iy]; render(); return; }
  S._lastImg=[ix,iy];
  if(S.dragBox){ S.tempBox=[Math.min(S.boxStart[0],ix),Math.min(S.boxStart[1],iy),
                            Math.max(S.boxStart[0],ix),Math.max(S.boxStart[1],iy)]; render(); return; }
  if(S.brush) render();
});
window.addEventListener('mouseup',(e)=>{
  if(S.panning){ S.panning=false; canvas.style.cursor=S.brush?'none':'crosshair'; return; }
  if(S.brushing){ S.brushing=false; S._lastImg=null; S.dirty=true; rebuildObjList(); return; }
  if(S.dragBox){
    S.dragBox=false;
    if(S.tempBox && Math.abs(S.tempBox[2]-S.tempBox[0])>=5 && Math.abs(S.tempBox[3]-S.tempBox[1])>=5){
      S.boxes.set(S.currentId, S.tempBox.slice());
      S.boxFlash={box:S.tempBox.slice(), color:'#37e5a0', start:performance.now(), dur:500};
      S.tempBox=null; tickBoxFlash(); runPredict();
    } else { S.tempBox=null; render(); }
  }
});

// -- wheel: ctrl=zoom at cursor, plain=pan --
canvas.addEventListener('wheel',(e)=>{
  if(!S.img) return;
  e.preventDefault();
  const rect=canvas.getBoundingClientRect(); const cx=e.clientX-rect.left, cy=e.clientY-rect.top;
  if(e.ctrlKey || e.metaKey){
    const factor=Math.exp(-e.deltaY*0.0015); setZoom(S.scale*factor, cx, cy);
  } else if(e.shiftKey){ S.panX-=e.deltaY; render(); }
  else { S.panY-=e.deltaY; S.panX-=e.deltaX; render(); }
},{passive:false});

// -- minimap pan --
let miniDrag=false;
function miniPan(e){
  const rect=mini.getBoundingClientRect(); const mx=e.clientX-rect.left, my=e.clientY-rect.top;
  const p=miniToImage(mx,my); if(!p) return;
  const [vw,vh]=vpSize(); S.panX=vw/2-p[0]*S.scale; S.panY=vh/2-p[1]*S.scale; render();
}
mini.addEventListener('mousedown',(e)=>{miniDrag=true; miniPan(e);});
window.addEventListener('mousemove',(e)=>{ if(miniDrag) miniPan(e); });
window.addEventListener('mouseup',()=>{miniDrag=false;});

// -- zoom HUD --
$('zoomSlider').addEventListener('input', e=> setZoom(+e.target.value/100));
$('zoomIn').addEventListener('click', ()=>setZoom(S.scale*1.2));
$('zoomOut').addEventListener('click', ()=>setZoom(S.scale/1.2));
/* ---------- legend: keep it on exactly one line ----------
   A wrapped legend makes the bottom bar taller and shoves the canvas up, so
   instead of guessing breakpoints we measure and drop the lowest-priority
   chips (data-pri, higher = dropped first) until the row fits.            */
let legendChips=null;
function fitLegend(){
  const box=$('legend'); if(!box || !box.clientWidth) return;
  if(!legendChips){
    legendChips=[...box.querySelectorAll('.kc')]
      .map((el,i)=>({el, pri:+el.dataset.pri||0, i}))
      .sort((a,b)=> b.pri-a.pri || b.i-a.i)      // low priority first, rightmost first
      .map(o=>o.el);
  }
  for(const el of legendChips) el.classList.remove('kc-off');
  let n=0;
  while(box.scrollWidth > box.clientWidth+1 && n<legendChips.length){
    legendChips[n++].classList.add('kc-off');
  }
}
let legendRaf=0;
function fitLegendSoon(){
  cancelAnimationFrame(legendRaf);
  legendRaf=requestAnimationFrame(fitLegend);
}
if(window.ResizeObserver) new ResizeObserver(fitLegendSoon).observe($('legend'));

/* ---------- panel layout: hide + drag-resize ----------
   Widths and the bottom-bar height live in CSS vars; collapse states are body
   classes. Everything is persisted so an annotator keeps their layout.        */
const LAYOUT_KEY='issas.layout';
const LAYOUT_DEF={left:236, right:268, bottom:null, hideL:false, hideR:false, hideB:false};
const LAYOUT_MIN={left:170, right:190, bottom:46};
const LAYOUT_MAX={left:560, right:600, bottom:360};
let Layout=Object.assign({}, LAYOUT_DEF);
try{ const raw=localStorage.getItem(LAYOUT_KEY); if(raw) Layout=Object.assign(Layout, JSON.parse(raw)); }catch(_){}

function saveLayout(){ try{ localStorage.setItem(LAYOUT_KEY, JSON.stringify(Layout)); }catch(_){} }
function applyLayout(persist){
  const b=document.body;
  b.style.setProperty('--left-w',  Layout.left+'px');
  b.style.setProperty('--right-w', Layout.right+'px');
  b.style.setProperty('--bottom-h', Layout.bottom? Layout.bottom+'px' : 'auto');
  b.classList.toggle('no-left',   Layout.hideL);
  b.classList.toggle('no-right',  Layout.hideR);
  b.classList.toggle('no-bottom', Layout.hideB);
  $('tglLeft').classList.toggle('on',   !Layout.hideL);
  $('tglRight').classList.toggle('on',  !Layout.hideR);
  $('tglBottom').classList.toggle('on', !Layout.hideB);
  if(persist!==false) saveLayout();
}
function togglePanel(which){
  const k = which==='left'?'hideL' : which==='right'?'hideR' : 'hideB';
  Layout[k]=!Layout[k]; applyLayout();
}
$('tglLeft').addEventListener('click',   ()=>togglePanel('left'));
$('tglRight').addEventListener('click',  ()=>togglePanel('right'));
$('tglBottom').addEventListener('click', ()=>togglePanel('bottom'));
$('collapseLeft').addEventListener('click',   ()=>togglePanel('left'));
$('collapseRight').addEventListener('click',  ()=>togglePanel('right'));
$('collapseBottom').addEventListener('click', ()=>togglePanel('bottom'));

// generic gutter drag; pointer capture keeps events coming when the cursor
// leaves the 11px handle, which it always does
function bindGutter(el, onMove, onReset){
  el.addEventListener('pointerdown', e=>{
    if(e.button!==0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging'); document.body.classList.add('resizing');
    const move=ev=>{ onMove(ev); applyLayout(false); };
    const up=()=>{
      el.classList.remove('dragging'); document.body.classList.remove('resizing');
      el.removeEventListener('pointermove',move);
      el.removeEventListener('pointerup',up);
      el.removeEventListener('pointercancel',up);
      saveLayout();
    };
    el.addEventListener('pointermove',move);
    el.addEventListener('pointerup',up);
    el.addEventListener('pointercancel',up);
  });
  el.addEventListener('dblclick', ()=>{ onReset(); applyLayout(); });
}
bindGutter($('gutterL'),
  ev=>{ const r=document.querySelector('.workspace').getBoundingClientRect();
        Layout.left = clampi(Math.round(ev.clientX - r.left - 12), LAYOUT_MIN.left, LAYOUT_MAX.left); },
  ()=>{ Layout.left = LAYOUT_DEF.left; });
bindGutter($('gutterR'),
  ev=>{ const r=document.querySelector('.workspace').getBoundingClientRect();
        Layout.right = clampi(Math.round(r.right - ev.clientX - 12), LAYOUT_MIN.right, LAYOUT_MAX.right); },
  ()=>{ Layout.right = LAYOUT_DEF.right; });
bindGutter($('gutterB'),
  ev=>{ Layout.bottom = clampi(Math.round(window.innerHeight - ev.clientY), LAYOUT_MIN.bottom, LAYOUT_MAX.bottom); },
  ()=>{ Layout.bottom = null; });

/* ---------- fullscreen ---------- */
function isFullscreen(){ return !!(document.fullscreenElement||document.webkitFullscreenElement); }
async function toggleFullscreen(){
  try{
    if(isFullscreen()){
      if(document.exitFullscreen) await document.exitFullscreen();
      else if(document.webkitExitFullscreen) document.webkitExitFullscreen();
    }else{
      const el=document.documentElement;
      if(el.requestFullscreen) await el.requestFullscreen();
      else if(el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      else { toast('Fullscreen not supported by this browser','err'); return; }
    }
  }catch(_){ toast('Fullscreen was blocked by the browser','err'); }
}
function syncFsBtn(){
  const on=isFullscreen();
  $('fsLabel').textContent = on? 'Exit' : 'Full';
  $('fsBtn').title = (on? 'Leave fullscreen' : 'Fullscreen') + ' (Ctrl+F)';
  $('fsBtn').classList.toggle('btn-accent', on);
}
$('fsBtn').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', syncFsBtn);
document.addEventListener('webkitfullscreenchange', syncFsBtn);

$('fitBtn').addEventListener('click', fitView);
$('oneToOneBtn').addEventListener('click', ()=>setZoom(1));

// -- visualization toggles --
const bindVis=(elId,key)=>{ $(elId).addEventListener('change',e=>{
  S.vis[key]=e.target.checked; if(key==='fill'||key==='boundary') invalidateAllTints(); render(); }); };
bindVis('visFill','fill'); bindVis('visBoundary','boundary'); bindVis('visIds','ids');
bindVis('visPoints','points'); bindVis('visBoxes','boxes');

// -- brush --
$('brushBtn').addEventListener('click',()=>{
  S.brush=!S.brush; const b=$('brushBtn');
  b.textContent='Brush: '+(S.brush?'ON':'OFF'); b.classList.toggle('on',S.brush);
  canvas.style.cursor=S.brush?'none':'crosshair'; render();
});
$('brushSlider').addEventListener('input',e=>{ S.brushSize=+e.target.value; $('brushLabel').textContent=S.brushSize; render(); });

// -- post-processing steppers --
document.querySelectorAll('[data-pp]').forEach(btn=>btn.addEventListener('click',()=>{
  const op=btn.dataset.pp, d=+btn.dataset.d;
  if(op==='gaussian'){ S.gauss=Math.max(1,S.gauss+d); $('gaussVal').textContent=S.gauss; }
  if(op==='morph'){ S.morph=Math.max(1,S.morph+d); $('morphVal').textContent=S.morph; }
  if(op==='components'){ S.comp=Math.max(1,S.comp+d); $('compVal').textContent=S.comp; }
}));
document.querySelectorAll('[data-apply]').forEach(btn=>btn.addEventListener('click',()=>applyPP(btn.dataset.apply)));

// -- add object (styled class picker) --
$('addObjBtn').addEventListener('click', openAddObj);
$('addObjClose').addEventListener('click', closeAddObj);
$('addObj').addEventListener('click', e=>{ if(e.target.id==='addObj') closeAddObj(); });
$('classSearch').addEventListener('input', renderClassList);
$('classSearch').addEventListener('keydown', e=>{
  if(e.key==='Enter'){ const first=$('classList').querySelector('.class-row'); if(first) first.click(); }
  if(e.key==='Escape') closeAddObj();
});

function openAddObj(){
  if(!S.count){ toast('Open a folder first'); return; }
  $('classSearch').value=''; renderClassList();
  $('addObj').classList.remove('hidden'); $('classSearch').focus();
}
function closeAddObj(){ $('addObj').classList.add('hidden'); }
function classDot(classId){ const [r,g,b]=colorForObj(classId*1000); return `rgb(${r},${g},${b})`; }

function renderClassList(){
  const q=$('classSearch').value.trim().toLowerCase();
  const list=$('classList'); list.innerHTML='';
  const known=new Set([...Object.keys(S.classGroups.tissue||{}), ...Object.keys(S.classGroups.instrument||{})]);
  const custom={}; for(const [n,i] of Object.entries(S.classMap)) if(!known.has(n)) custom[n]=i;
  const groups=[['Tissue & organs', S.classGroups.tissue||{}],
                ['Instruments', S.classGroups.instrument||{}]];
  if(Object.keys(custom).length) groups.push(['Custom', custom]);

  for(const [gname,gmap] of groups){
    const names=Object.keys(gmap).filter(n=>n.toLowerCase().includes(q));
    if(!names.length) continue;
    const gl=document.createElement('div'); gl.className='class-group'; gl.textContent=gname; list.appendChild(gl);
    for(const n of names){
      const row=document.createElement('div'); row.className='class-row';
      row.innerHTML=`<span class="obj-dot" style="background:${classDot(gmap[n])}"></span>
        <span class="class-name">${n}</span><span class="mono class-id">#${gmap[n]}</span>`;
      row.addEventListener('click',()=>{ addObject(gmap[n], n); closeAddObj(); });
      list.appendChild(row);
    }
  }
  // offer to create a custom class when the typed name isn't an exact match
  const raw=$('classSearch').value.trim();
  if(raw && !Object.keys(S.classMap).some(n=>n.toLowerCase()===raw.toLowerCase())){
    const norm=raw.charAt(0).toUpperCase()+raw.slice(1);
    const row=document.createElement('div'); row.className='class-row custom-row';
    row.innerHTML=`<span class="ico">＋</span><span class="class-name">Add custom class “${norm}”</span>`;
    row.addEventListener('click',()=>{
      const ids=Object.values(S.classMap); const cid=(ids.length?Math.max(...ids):0)+1;
      S.classMap[norm]=cid; addObject(cid, norm); closeAddObj();
    });
    list.appendChild(row);
  }
}

// -- propagation toggle --
$('propBtn').addEventListener('click',()=>{
  S.propagation=!S.propagation; const b=$('propBtn');
  b.textContent='Propagation: '+(S.propagation?'ON':'OFF'); b.classList.toggle('on',S.propagation);
});

// -- re-propagate from current frame (gated on Propagation ON) --
$('reseedBtn').addEventListener('click', reseedFromHere);
async function reseedFromHere(){
  if(!S.count){ toast('Open a folder first'); return; }
  if(!S.propagation){ toast('Turn Propagation ON to re-propagate','err'); return; }
  if(!S.sam2){ toast('Re-propagate needs SAM2 (not simulation)','err'); return; }
  const objects=[];
  for(const id of S.order){
    const obj=S.objects.get(id);
    if(obj.visible && obj.bin.some(v=>v)) objects.push({obj_id:id, mask:binToPngB64(obj.bin)});
  }
  if(objects.length===0){ toast('No visible masks on this frame to seed','err'); return; }
  showOverlay('Re-propagating from here…');
  const {ok,j}=await API.post('/api/propagate/reseed',{frame_idx:S.idx, objects});
  hideOverlay();
  if(!ok){ toast(j.detail||'re-propagate failed','err'); return; }
  commitFrame(S.idx);                 // this frame's corrected masks are the new seed
  // downstream frames must regenerate freshly on forward-step
  for(const f of [...S.frameMasks.keys()]) if(f>S.idx) S.frameMasks.delete(f);
  clearRawAfter(S.idx);
  if(S.refineSrc){ S.refineSrc=null; }   // propagation now drives forward, not the annotator's sparse masks
  flashScreen();
  toast(`Re-propagated from frame ${S.idx+1} · seeded ${j.seeded} (${j.seed_kind})`,'ok');
}

// -- Dice report: SAM2-initial vs human-final --
$('diceBtn').addEventListener('click', diceReport);
async function diceReport(){
  if(!S.count){ toast('Open a folder first'); return; }
  commitFrame(S.idx);                 // include the live frame's final masks
  const records=[];
  for(const [frame, m] of S.rawMasks){
    const finals=S.frameMasks.get(frame);
    for(const [objId, raw] of m){
      const finBin = finals && finals.get(objId);
      if(!finBin && !raw.bin.some(v=>v)) continue;   // nothing on either side
      records.push({
        frame_idx:frame, obj_id:objId, class_id:raw.classId, kind:raw.kind,
        raw: binToPngB64(raw.bin),
        final: binToPngB64(finBin || new Uint8Array(S.W*S.H)),
      });
    }
  }
  if(records.length===0){ toast('No SAM2 masks captured yet — annotate some frames first'); return; }
  showOverlay('Computing Dice…');
  const {ok,j}=await API.post('/api/dice',{records}); hideOverlay();
  if(!ok){ toast(j.detail||'dice failed','err'); return; }
  S.lastDice=j; renderDicePanel(j);
}
function fmtDice(v){ return v==null? '—' : v.toFixed(3); }
function renderDicePanel(j){
  const el=$('diceBody');
  const block=(title,s)=>{
    if(!s || s.n===0) return `<div class="dice-block"><div class="dice-h">${title}</div><div class="muted">no records</div></div>`;
    const rows=s.per_class.map(c=>`<tr><td>${c.class_name}</td><td class="mono">${c.n}</td>
      <td class="mono">${fmtDice(c.mean_dice)}</td><td class="mono">${c.empty_initial||''}</td></tr>`).join('');
    return `<div class="dice-block">
      <div class="dice-h">${title} <span class="mono dice-overall">mean ${fmtDice(s.overall_mean_dice)} · n=${s.n}</span></div>
      <table class="dice-table"><thead><tr><th>class</th><th>n</th><th>Dice</th><th>empty init</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  };
  el.innerHTML = block('Propagation frames', j.propagation)
              + block('Prompt frames', j.prompt)
              + block('All frames', j.all);
  $('diceModal').classList.remove('hidden');
}
$('diceClose').addEventListener('click',()=>$('diceModal').classList.add('hidden'));
$('diceModal').addEventListener('click',e=>{ if(e.target.id==='diceModal') $('diceModal').classList.add('hidden'); });
$('diceCsv').addEventListener('click',()=>downloadDice('csv'));
$('diceJson').addEventListener('click',()=>downloadDice('json'));
function downloadDice(fmt){
  if(!S.lastDice){ return; }
  let blob, name;
  if(fmt==='json'){ blob=new Blob([JSON.stringify(S.lastDice,null,2)],{type:'application/json'}); name='issas_dice.json'; }
  else {
    const head='frame,class_id,class_name,obj_id,kind,dice,initial_area,final_area,empty_initial,empty_final';
    const lines=S.lastDice.rows.map(r=>[r.frame_idx,r.class_id,`"${r.class_name}"`,r.obj_id,r.kind,
      r.dice,r.initial_area,r.final_area,r.empty_initial,r.empty_final].join(','));
    blob=new Blob([head+'\n'+lines.join('\n')],{type:'text/csv'}); name='issas_dice.csv';
  }
  const url=URL.createObjectURL(blob); const a=document.createElement('a');
  a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url);
}

// ---------- Review mode: multi-annotator agreement ----------
const R = {scan:null, data:null, kind:'inter', metric:'dice', sort:'value-desc', agg:'macro'};
$('reviewBtn').addEventListener('click', openReview);
$('reviewClose').addEventListener('click',()=>$('reviewModal').classList.add('hidden'));
$('reviewModal').addEventListener('click',e=>{ if(e.target.id==='reviewModal') $('reviewModal').classList.add('hidden'); });
$('reviewBrowse').addEventListener('click',()=>openBrowser({title:'Choose Results root', start:$('reviewRoot').value||R.defaultRoot, onSelect:p=>{ if(p){ $('reviewRoot').value=p; reviewScan(); } }}));
$('reviewScan').addEventListener('click', reviewScan);
$('refineFoldToggle').addEventListener('click', ()=>{
  $('refineFold').classList.toggle('open');
  $('refineFold').querySelector('.fold-body').classList.toggle('hidden');
});
$('reviewCompute').addEventListener('click', reviewCompute);
$('refineFramesBrowse').addEventListener('click',()=>openBrowser({title:'Choose frames folder (images) for this case', start:$('refineFrames').value||S.defaultPath, onSelect:p=>{ if(p) $('refineFrames').value=p; }}));
$('refineGo').addEventListener('click', ()=>refineInEditor(
  $('reviewRoot').value.trim(), $('reviewCase').value, $('refineAnn').value,
  $('refineFrames').value.trim(), $('refineReviewer').value.trim()||'reviewer'));
async function refineInEditor(root, cse, ann, framesDir, rid){
  if(!root||!cse||!ann){ toast('Scan and pick a case + annotator','err'); return; }
  if(!framesDir){ toast('Set the frames folder (the images)','err'); return; }
  showOverlay('Loading frames…');
  const {ok,j}=await API.post('/api/open_folder',{path:framesDir});
  if(!ok){ hideOverlay(); toast(j.detail||'open failed','err'); return; }
  S.count=j.count; S.frames=j.names; S.sam2=j.sam2_available; S.device=j.device;
  $('modeBadge').textContent = S.sam2? `SAM · ${S.device}` : 'simulation';
  $('modeBadge').className = 'badge '+(S.sam2?'badge-live':'badge-sim');
  $('frameSlider').max=S.count-1; $('folderPath').value=framesDir;
  S.objects.clear(); S.order=[]; S.currentId=null; S.frameMasks.clear(); S.rawMasks.clear();
  saveConfigured=false; S.dirty=false; pendingFrame=null; rebuildObjList();
  await API.post('/api/init',{}); hideOverlay();
  // reviewer output + auto-import source (works even with a single annotator)
  $('pngDir').value = `${root}/${rid}/${cse}/masks`;
  $('yoloDir').value = `${root}/${rid}/${cse}/labels`;
  $('exportPngOnly').checked = true;   // reviewer masks are for analysis → lossless
  S.refineSrc = `${root}/${ann}/${cse}`;
  S.propagation=false; $('propBtn').textContent='Propagation: OFF'; $('propBtn').classList.remove('on');
  $('reviewModal').classList.add('hidden');
  $('compareModal').classList.add('hidden'); C.open=false;
  await loadFrame(0,{force:true, noProp:true}); fitViewSoon();
  toast(`Refining ${ann} → saves to ${rid}/${cse} (PNG)`,'ok');
}
$('reviewCsv').addEventListener('click',()=>downloadReview('csv'));
$('reviewJson').addEventListener('click',()=>downloadReview('json'));
segBind('reviewKind','k',v=>{R.kind=v; renderReview();});
segBind('reviewMetric','m',v=>{R.metric=v; renderReview();});
segBind('reviewSort','s',v=>{R.sort=v; renderReview();});
segBind('reviewAgg','g',v=>{R.agg=v; renderReview();});
// collapsible result sections — delegated so binding never misses
$('reviewResults').addEventListener('click', e=>{
  const h=e.target.closest('.rsec-head'); if(!h) return;
  const sec=document.getElementById(h.dataset.sec); if(sec) sec.classList.toggle('collapsed');
});
function segBind(id,attr,cb){
  $(id).addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b) return;
    [...$(id).children].forEach(x=>x.classList.remove('on')); b.classList.add('on'); cb(b.dataset[attr]); });
}
async function openReview(){
  if(!$('reviewRoot').value){
    try{ const d=await API.get('/api/review/default_root'); R.defaultRoot=d.root; $('reviewRoot').value=d.root; }catch(_){}
  }
  $('reviewModal').classList.remove('hidden');
  const card=$('reviewModal').querySelector('.review-card');
  if(!card._dragInit){ makeDraggable(card, card.querySelector('.modal-head')); card._dragInit=true; }
  card._resetDrag && card._resetDrag();
}
async function reviewScan(){
  const root=$('reviewRoot').value.trim(); if(!root){ toast('Set a Results root','err'); return; }
  showOverlay('Scanning…');
  const {ok,j}=await API.post('/api/review/scan',{root}); hideOverlay();
  if(!ok){ toast(j.detail||'scan failed','err'); return; }
  R.scan=j;
  const sel=$('reviewCase');
  sel.innerHTML='<option value="ALL">— ALL cases —</option>'+j.cases.map(c=>`<option>${c}</option>`).join('');
  sel.onchange=renderAnnChecks; renderAnnChecks();
  if(!j.cases.length) toast('No cases found under that root','err');
}
function renderAnnChecks(){
  const c=$('reviewCase').value;
  const box=$('reviewAnns'); box.innerHTML='';
  const all=(c==='ALL');
  const withCase = all? R.scan.annotators.filter(a=>Object.keys(a.cases).length)
                      : R.scan.annotators.filter(a=>a.cases[c]);
  $('refineAnn').innerHTML=withCase.map(a=>`<option>${a.id}</option>`).join('');
  if(!all) resolveFramesDir(c).then(d=>{ $('refineFrames').value=d; });
  if(!withCase.length){ box.innerHTML='<span class="muted">No annotators here.</span>'; return; }
  for(const a of withCase){
    const el=document.createElement('label'); el.className='rcheck';
    const chk = a.is_sam? '' : 'checked';
    const tag = a.is_sam? ' <span class="flag" style="color:var(--amber)">SAM</span>' : '';
    const cnt = all? Object.keys(a.cases).length+'c' : a.cases[c]+'f';
    el.innerHTML=`<input type="checkbox" ${chk} value="${a.id}"><span>${a.id}${tag}</span><span class="cnt">${cnt}</span>`;
    box.appendChild(el);
  }
}
async function resolveFramesDir(cse){
  if(!R.framesBase){ try{ const b=await API.get('/api/review/frames_base'); R.framesBase=b.base; }catch(_){ R.framesBase=''; } }
  const {ok,j}=await API.post('/api/review/resolve_frames',{base:R.framesBase, case:cse});
  if(ok && !j.found) toast(`No images found under ${j.dir} — set the frames folder manually`,'err');
  return ok? j.dir : (R.framesBase? R.framesBase+'/'+cse : '');
}
async function reviewCompute(){
  const root=$('reviewRoot').value.trim(); const c=$('reviewCase').value;
  const anns=[...$('reviewAnns').querySelectorAll('input:checked')].map(x=>x.value);
  if(anns.length<2){ toast('Select at least 2 annotators','err'); return; }
  showOverlay(c==='ALL'? 'Computing agreement across all cases…' : 'Computing agreement…');
  const {ok,j}=await API.post('/api/review/agreement',{root, case:c, annotators:anns}); hideOverlay();
  if(!ok){ toast(j.detail||'agreement failed','err'); return; }
  R.data=j; $('reviewResults').classList.remove('hidden'); renderReview();
  toast(j.multi? `All cases (${j.cases.length}) · saved to _review_all/` : `Saved to ${j.case}/_review/`,'ok');
}
function reviewBar(name, v, higherBetter, maxv, extraTip, nlabel, isAvg, weightedVal){
  const w = (v==null?0 : (higherBetter? v*100 : v/maxv*100)).toFixed(1);
  const cls = (higherBetter?'bar-fill':'bar-fill warn');
  const valTxt = v==null?'—':(higherBetter?v.toFixed(3):v.toFixed(1));
  const wtd = (isAvg && weightedVal!=null)? `<span class="bar-weighted"> · wt ${higherBetter?weightedVal.toFixed(3):weightedVal.toFixed(1)}</span>`:'';
  return `<div class="bar-row${isAvg?' avg':''}" title="${(extraTip||name).replace(/"/g,'&quot;')}"><span class="bar-label">${name}</span>
    <div class="bar-track"><div class="${cls}" style="width:${w}%"></div></div>
    <span class="bar-val">${valTxt}${wtd}</span><span class="bar-n">${nlabel||''}</span></div>`;
}
function renderReview(){
  if(!R.data) return;
  const sub=R.data[R.kind]; const m=R.metric; const multi=R.data.multi;
  const kindLabel={inter:'Inter-observer', intra:'Intra-observer', all:'All pairs'}[R.kind];
  const pset=new Set();
  for(const r of R.data.rows){ if(R.kind==='all'||r.kind===R.kind) pset.add(`${r.ann_a} – ${r.ann_b}`); }
  const pairs=[...pset];
  const scope = multi? ` · across ${R.data.cases.length} cases (macro headline)` : '';
  $('reviewPairs').innerHTML = pairs.length
    ? `<b>${kindLabel}</b>${scope} · ${pairs.length} pair${pairs.length>1?'s':''}: ${pairs.join(' · ')}`
    : `<b>${kindLabel}</b> · no pairs (need ${R.kind==='intra'?'repeat passes of one annotator':'≥2 annotators'})`;
  const higherBetter = (m==='dice'||m==='iou');
  const useMicro = (R.agg==='micro');
  const pcVal = x => useMicro ? x[m+'_micro'] : x[m];      // headline metric per class
  $('reviewAgg').classList.toggle('hidden', !multi);        // macro==micro when single-case

  // ---- per-class chart ----
  let pc=[...sub.per_class];
  pc.sort((a,b)=>{
    if(R.sort==='name') return a.class_name.localeCompare(b.class_name);
    if(R.sort==='n') return b.n-a.n;
    const av=pcVal(a), bv=pcVal(b); if(av==null) return 1; if(bv==null) return -1;
    return R.sort==='value-asc'? av-bv : bv-av;
  });
  const aggLabel = useMicro? 'micro (pooled)' : 'macro (per-case avg)';
  const shown = pc.map(pcVal).filter(v=>v!=null);
  const classUnweighted = shown.length? shown.reduce((s,v)=>s+v,0)/shown.length : null;
  const maxPC=Math.max(0.0001,...pc.map(x=>pcVal(x)==null?0:pcVal(x)), classUnweighted||0);
  let html = pc.map(x=>{
    const tip = multi
      ? `${x.class_name}\nmacro (per-case avg): ${fmtn(x[m])}\nmicro (pooled): ${fmtn(x[m+'_micro'])}\nsamples n=${x.n} over ${x.n_cases} case(s)  ·  showing ${aggLabel}`
      : `${x.class_name} · ${x.n} pairs`;
    const nlab = multi? `n=${x.n}·${x.n_cases}c` : `n=${x.n}`;
    return reviewBar(x.class_name, pcVal(x), higherBetter, maxPC, tip, nlab, false);
  }).join('') || '<div class="muted">No overlapping classes for this split.</div>';
  if(pc.length){
    html += reviewBar('Average', classUnweighted, higherBetter, maxPC,
      `Unweighted mean of the ${aggLabel} class values above (n-weighted = pooled shown beside as "wt")`,
      '', true, sub.overall? sub.overall[m]: null);
  }
  $('reviewChart').innerHTML=html;

  // ---- per-case chart (ALL mode only) — also honors Macro/Micro ----
  $('rsecCase').classList.toggle('hidden', !multi);
  const caseAggLabel = useMicro? 'micro (pooled over samples)' : 'macro (per-class avg)';
  if(multi && sub.per_case){
    let cc=[...sub.per_case];
    cc.sort((a,b)=>{
      if(R.sort==='name') return a.case.localeCompare(b.case);
      if(R.sort==='n') return b.n-a.n;
      const av=pcVal(a), bv=pcVal(b); if(av==null) return 1; if(bv==null) return -1;
      return R.sort==='value-asc'? av-bv : bv-av;
    });
    const cShown=cc.map(pcVal).filter(v=>v!=null);
    const caseUnweighted=cShown.length? cShown.reduce((s,v)=>s+v,0)/cShown.length : null;
    const maxCC=Math.max(0.0001,...cc.map(x=>pcVal(x)==null?0:pcVal(x)), caseUnweighted||0);
    let ch=cc.map(x=>reviewBar(x.case, pcVal(x), higherBetter, maxCC,
      `${x.case}\nmacro (per-class avg): ${fmtn(x[m])}\nmicro (pooled): ${fmtn(x[m+'_micro'])}\nn=${x.n} samples  ·  showing ${caseAggLabel}`,
      `n=${x.n}`, false)).join('');
    ch+=reviewBar('Average', caseUnweighted, higherBetter, maxCC,
      `Unweighted mean across cases (every case counts equally) of the ${caseAggLabel} values; n-weighted pooled shown beside as "wt"`,
      '', true, sub.overall? sub.overall[m]:null);
    $('reviewCaseChart').innerHTML=ch;
  }

  const ov=sub.overall;
  $('reviewOverall').textContent = `${R.kind}${multi?' · all cases':''}: mean Dice ${fmtn(ov.dice)} · IoU ${fmtn(ov.iou)} · HD ${fmtn(ov.hd)} · HD95 ${fmtn(ov.hd95)} · ${sub.n} pairs · ${R.data.n_shared_frames} shared frames`;
  const mv=(x,k)=> useMicro? x[k+'_micro'] : x[k];
  const rows=pc.map(x=>`<tr><td>${x.class_name}</td><td class="mono">${x.n}</td>
    <td class="mono">${fmtn(mv(x,'dice'))}</td><td class="mono">${fmtn(mv(x,'iou'))}</td>
    <td class="mono">${fmtn(mv(x,'hd'))}</td><td class="mono">${fmtn(mv(x,'hd95'))}</td>
    <td class="mono">${x.one_sided||''}</td></tr>`).join('');
  const aggNote = multi? ` (${useMicro?'micro / pooled':'macro / per-case avg'})` : '';
  $('reviewTable').innerHTML=`<thead><tr><th>class</th><th title="Samples = pairs × frames where both annotators labelled the class">n</th><th title="showing ${useMicro?'micro (pooled)':'macro (per-case averaged)'} values">Dice${aggNote}</th><th>IoU</th><th>HD</th><th>HD95</th><th title="Count of samples where one annotator labelled the class but the other did not (presence disagreement). Included in Dice/IoU (compared to an empty mask, so those drop); excluded from HD/HD95.">1-sided</th></tr></thead><tbody>${rows}</tbody>`;
}
function fmtn(v){ return v==null?'—':(''+v); }
function downloadReview(fmt){
  if(!R.data){ return; }
  let blob,name;
  if(fmt==='json'){ blob=new Blob([JSON.stringify(R.data,null,2)],{type:'application/json'}); name=`agreement_${R.data.case}.json`; }
  else {
    const head='frame,class_id,class_name,ann_a,ann_b,kind,one_sided,dice,iou,hd,hd95';
    const lines=R.data.rows.map(r=>[r.frame,r.class_id,`"${r.class_name}"`,r.ann_a,r.ann_b,r.kind,
      r.one_sided,r.dice,r.iou,r.hd,r.hd95].join(','));
    blob=new Blob([head+'\n'+lines.join('\n')],{type:'text/csv'}); name=`agreement_${R.data.case}.csv`;
  }
  const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url);
}

// ---------- Compare: visual diff / dual-screen ----------
const C = {open:false, root:null, case:null, a:null, b:null, frames:[], idx:0,
           mode:'overlay', framesDir:'', showFrame:true, w:0, h:0, data:null, img:null,
           bins:{}, visible:new Set(), solo:null, classSort:{key:'dice',dir:-1},
           view:{scale:1,panX:0,panY:0}, panning:false, panStart:null,
           layer:null, layerA:null, layerB:null, scores:[], scoreHover:null};
const cmpCanvas=$('cmpCanvas'); const cctx=cmpCanvas.getContext('2d');
const CMP_AGREE=[55,229,160], CMP_AONLY=[80,180,255], CMP_BONLY=[255,90,170];
function classColorRGB(cid){ return colorForObj(cid*1000); }

$('reviewCompareBtn').addEventListener('click', openCompare);
$('cmpRefineA').addEventListener('click',()=>refineInEditor(C.root, C.case, C.a, C.framesDir, $('refineReviewer').value.trim()||'reviewer'));
$('cmpRefineB').addEventListener('click',()=>refineInEditor(C.root, C.case, C.b, C.framesDir, $('refineReviewer').value.trim()||'reviewer'));
$('cmpClose').addEventListener('click',()=>{ $('compareModal').classList.add('hidden'); C.open=false; });
$('cmpFramesBrowse').addEventListener('click',()=>openBrowser({title:'Choose frames folder for this case', start:C.framesDir||S.defaultPath, onSelect:p=>{ if(p){ C.framesDir=p; $('cmpFramesDir').value=p; loadCmpFrame(C.idx); } }}));
$('cmpFramesDir').addEventListener('change',e=>{ C.framesDir=e.target.value.trim(); loadCmpFrame(C.idx); });
$('cmpShowFrame').addEventListener('change',e=>{ C.showFrame=e.target.checked;
  if(C.showFrame && !C.framesDir) toast('Set a frames folder to show the background');
  cmpRender(); });
$('cmpPrev').addEventListener('click',()=>loadCmpFrame(C.idx-1));
$('cmpNext').addEventListener('click',()=>loadCmpFrame(C.idx+1));
$('cmpSlider').addEventListener('change',e=>loadCmpFrame(+e.target.value));
$('cmpA').addEventListener('change',()=>{ C.a=$('cmpA').value; reloadCmpFrames(); });
$('cmpB').addEventListener('change',()=>{ C.b=$('cmpB').value; reloadCmpFrames(); });
segBind('cmpMode','cm',v=>{ C.mode=v; buildCmpLayers(); cmpRender(); updateLegend(); });
$('cmpSort').addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b) return;
  const key=b.dataset.cs;
  if(C.classSort.key===key){ C.classSort.dir*=-1; }
  else { C.classSort.key=key; C.classSort.dir = (key==='class_name'||key==='hd95')? 1 : -1; }
  [...$('cmpSort').children].forEach(x=>x.classList.toggle('on',x.dataset.cs===key));
  renderCmpClasses(); });
$('cmpAll').addEventListener('change',e=>{
  C.solo=null;
  C.visible = e.target.checked ? new Set(C.data.classes.map(c=>c.class_id)) : new Set();
  buildCmpLayers(); cmpRender(); renderCmpClasses();
});

async function openCompare(){
  if(!R.data){ toast('Compute agreement first'); return; }
  C.root=R.data.root; C.case=R.data.case;
  const withCase=R.scan.annotators.filter(a=>a.cases[C.case]).map(a=>a.id);
  const opts=withCase.map(id=>`<option>${id}</option>`).join('');
  $('cmpA').innerHTML=opts; $('cmpB').innerHTML=opts;
  const sel=R.data.annotators;
  C.a=sel[0]; C.b=sel[1]||withCase.find(x=>x!==sel[0])||sel[0];
  $('cmpA').value=C.a; $('cmpB').value=C.b;
  $('compareModal').classList.remove('hidden'); C.open=true;
  // default frames folder for this case, so the background shows without extra steps
  C.framesDir = await resolveFramesDir(C.case);
  $('cmpFramesDir').value = C.framesDir; C.showFrame=true; $('cmpShowFrame').checked=true;
  const card=$('compareModal').querySelector('.compare-card');
  if(!card._dragInit){ makeDraggable(card, card.querySelector('.modal-head'));
    new ResizeObserver(()=>{ if(C.open){ compareResize(); cmpRender(); drawScores(); } }).observe(card); card._dragInit=true; }
  card._resetDrag && card._resetDrag();
  compareResize();
  await reloadCmpFrames();
}
function makeDraggable(card, handle){
  let dx=0,dy=0,sx,sy,drag=false;
  handle.style.cursor='move';
  handle.addEventListener('mousedown',e=>{ if(e.target.closest('button,select,input,label')) return; drag=true; sx=e.clientX-dx; sy=e.clientY-dy; e.preventDefault(); });
  window.addEventListener('mousemove',e=>{ if(!drag) return; dx=e.clientX-sx; dy=e.clientY-sy; card.style.transform=`translate(${dx}px,${dy}px)`; });
  window.addEventListener('mouseup',()=>{ drag=false; });
  card._resetDrag=()=>{ dx=0; dy=0; card.style.transform=''; };
}
async function reloadCmpFrames(){
  if(C.a===C.b){ toast('Pick two different annotators','err'); return; }
  const {ok,j}=await API.post('/api/review/frames',{root:C.root, case:C.case, ann_a:C.a, ann_b:C.b});
  if(!ok){ toast(j.detail||'no frames','err'); return; }
  C.frames=j.frames; C.idx=0;
  $('cmpSlider').max=Math.max(0,C.frames.length-1);
  if(!C.frames.length){ toast('No frames shared by these two','err'); $('cmpClasses').innerHTML=''; cctx.clearRect(0,0,cmpCanvas.width,cmpCanvas.height); C.scores=[]; drawScores(); return; }
  const sc=await API.post('/api/review/frame_scores',{root:C.root, case:C.case, ann_a:C.a, ann_b:C.b});
  C.scores = sc.ok? sc.j.scores : [];
  loadCmpFrame(0);
}
async function loadCmpFrame(i){
  if(!C.frames.length) return;
  C.idx=clampi(i,0,C.frames.length-1);
  const frame=C.frames[C.idx];
  const {ok,j}=await API.post('/api/review/frame_compare',{root:C.root, case:C.case, ann_a:C.a, ann_b:C.b, frame});
  if(!ok){ toast(j.detail||'compare failed','err'); return; }
  C.data=j; C.w=j.width; C.h=j.height;
  // decode masks
  C.bins={};
  for(const cl of j.classes){
    C.bins[cl.class_id]={
      a:await pngB64ToBinWH(cl.mask_a,C.w,C.h),
      b:await pngB64ToBinWH(cl.mask_b,C.w,C.h),
      color:classColorRGB(cl.class_id), meta:cl };
  }
  if(C.visible.size===0 || C.solo===null){ C.visible=new Set(j.classes.map(c=>c.class_id)); }
  // background image
  C.img=null;
  if(C.framesDir){
    await new Promise(res=>{ const im=new Image(); im.onload=()=>{C.img=im;res();}; im.onerror=()=>res(); im.src='/api/review/image?dir='+encodeURIComponent(C.framesDir)+'&frame='+encodeURIComponent(frame); });
  }
  $('cmpSlider').value=C.idx; $('cmpPos').textContent=`${C.idx+1} / ${C.frames.length}`; $('cmpFrameName').textContent=frame;
  fitCmp(); buildCmpLayers(); renderCmpClasses(); cmpRender(); updateLegend(); drawScores();
}
// per-frame Dice line plot (color = spectrum), click a point to jump
const scoresCanvas=$('cmpScores'); const sctx=scoresCanvas.getContext('2d');
function diceSpectrum(d){ const hue=Math.max(0,Math.min(130,d*130)); return `hsl(${hue.toFixed(0)},72%,55%)`; }
function scoreLayout(){
  const wrap=scoresCanvas.parentElement;
  const W=wrap.clientWidth-32, H=wrap.clientHeight-6;
  const n=(C.scores||[]).length;
  const padL=46, padR=14, padT=13, padB=15;
  const availW=Math.max(10, W-padL-padR);
  const step = n<=1? 0 : Math.min(46, availW/(n-1));   // capped => denser for few frames
  const dv=(C.scores||[]).filter(s=>s.dice!=null).map(s=>s.dice);
  let lo=dv.length?Math.min(...dv):0, hi=dv.length?Math.max(...dv):1;
  const pad=Math.max(0.02,(hi-lo)*0.15); lo=Math.max(0,lo-pad); hi=Math.min(1,hi+pad);
  if(hi-lo<0.04){ const c=(hi+lo)/2; lo=Math.max(0,c-0.02); hi=Math.min(1,c+0.02); }
  return {W,H,n,padL,padR,padT,padB,step,lo,hi};
}
const scoreX=(i,L)=> L.padL + i*L.step;
const scoreY=(d,L)=> (L.H-L.padB) - ((d-L.lo)/Math.max(1e-6,L.hi-L.lo))*(L.H-L.padT-L.padB);
function drawScores(){
  const dp=window.devicePixelRatio||1; const L=scoreLayout(); const W=L.W,H=L.H;
  scoresCanvas.width=W*dp; scoresCanvas.height=H*dp; sctx.setTransform(dp,0,0,dp,0,0);
  sctx.clearRect(0,0,W,H);
  if(!L.n) return;
  // autoscaled y grid + labels (top = hi, bottom = lo)
  sctx.font='9px ui-monospace, monospace'; sctx.textAlign='right'; sctx.textBaseline='middle';
  [[L.hi,L.padT],[L.lo,H-L.padB]].forEach(([v,yy])=>{
    sctx.strokeStyle='rgba(255,255,255,.06)'; sctx.lineWidth=1; sctx.beginPath(); sctx.moveTo(L.padL,yy); sctx.lineTo(W-L.padR,yy); sctx.stroke();
    sctx.fillStyle='#79828d'; sctx.fillText(v.toFixed(3), L.padL-6, yy);
  });
  // line
  sctx.strokeStyle='rgba(255,255,255,.25)'; sctx.lineWidth=1.5; sctx.beginPath(); let started=false;
  C.scores.forEach((s,i)=>{ if(s.dice==null) return; const px=scoreX(i,L),py=scoreY(s.dice,L); if(!started){sctx.moveTo(px,py);started=true;} else sctx.lineTo(px,py); });
  sctx.stroke();
  // dots (color = true dice, not the scaled axis)
  C.scores.forEach((s,i)=>{ const px=scoreX(i,L),py=scoreY(s.dice==null?L.lo:s.dice,L);
    sctx.fillStyle = s.dice==null? '#555' : diceSpectrum(s.dice);
    const r = i===C.idx?5 : (i===C.scoreHover?5:3.5);
    sctx.beginPath(); sctx.arc(px,py,r,0,Math.PI*2); sctx.fill();
    if(i===C.idx){ sctx.strokeStyle='#fff'; sctx.lineWidth=1.5; sctx.stroke(); }
  });
  // hover tooltip
  if(C.scoreHover!=null && C.scores[C.scoreHover]){
    const s=C.scores[C.scoreHover]; const px=scoreX(C.scoreHover,L), py=scoreY(s.dice==null?L.lo:s.dice,L);
    const txt=`${s.frame}  ·  Dice ${s.dice==null?'—':s.dice.toFixed(4)}`;
    sctx.font='10px ui-monospace, monospace'; sctx.textAlign='left'; sctx.textBaseline='alphabetic';
    const tw=sctx.measureText(txt).width, bw=tw+12, bh=17;
    let bx=px+8; if(bx+bw>W-4) bx=px-8-bw; const by=Math.max(2,py-bh-6);
    sctx.fillStyle='rgba(12,15,18,.95)'; sctx.strokeStyle='#232a31'; sctx.lineWidth=1;
    sctx.beginPath(); sctx.roundRect? sctx.roundRect(bx,by,bw,bh,5): sctx.rect(bx,by,bw,bh); sctx.fill(); sctx.stroke();
    sctx.fillStyle='#dbe1e8'; sctx.fillText(txt, bx+6, by+12);
  }
}
function nearestScore(e){
  const L=scoreLayout(); if(!L.n) return -1;
  const mx=e.clientX-scoresCanvas.getBoundingClientRect().left;
  let best=0,bd=1e9; for(let i=0;i<L.n;i++){ const d=Math.abs(scoreX(i,L)-mx); if(d<bd){bd=d;best=i;} }
  return best;
}
scoresCanvas.addEventListener('click',e=>{ const i=nearestScore(e); if(i>=0) loadCmpFrame(i); });
scoresCanvas.addEventListener('mousemove',e=>{ const i=nearestScore(e); if(i!==C.scoreHover){ C.scoreHover=i; drawScores(); } });
scoresCanvas.addEventListener('mouseleave',()=>{ if(C.scoreHover!=null){ C.scoreHover=null; drawScores(); } });

// image serving via GET with query — add a tiny fetch-based loader since web_fetch not used here
function pngB64ToBinWH(b64,w,h){
  return new Promise(res=>{ const im=new Image(); im.onload=()=>{ const c=document.createElement('canvas'); c.width=w;c.height=h; const cx=c.getContext('2d'); cx.drawImage(im,0,0,w,h); const d=cx.getImageData(0,0,w,h).data; const bin=new Uint8Array(w*h); for(let i=0,p=0;i<bin.length;i++,p+=4) bin[i]=d[p]>127?1:0; res(bin); }; im.src='data:image/png;base64,'+b64; });
}
function visClasses(){ return Object.keys(C.bins).map(Number).filter(cid=> C.solo!=null? cid===C.solo : C.visible.has(cid)); }

function mkLayer(paint){ const c=document.createElement('canvas'); c.width=C.w; c.height=C.h; const cx=c.getContext('2d'); const im=cx.createImageData(C.w,C.h); paint(im.data); cx.putImageData(im,0,0); return c; }
function paintFill(d,bin,color,alpha){ for(let i=0,p=0;i<bin.length;i++,p+=4){ if(bin[i]){ d[p]=color[0]; d[p+1]=color[1]; d[p+2]=color[2]; d[p+3]=alpha; } } }
function paintBoundary(d,bin,color){ const w=C.w,h=C.h; for(let y=0;y<h;y++)for(let x=0;x<w;x++){ const i=y*w+x; if(!bin[i])continue; if(x===0||y===0||x===w-1||y===h-1||!bin[i-1]||!bin[i+1]||!bin[i-w]||!bin[i+w]){ const p=i*4; d[p]=color[0];d[p+1]=color[1];d[p+2]=color[2];d[p+3]=255; } } }
function buildCmpLayers(){
  if(!C.data) return;
  const vis=visClasses();
  if(C.mode==='diff'){
    C.layer=mkLayer(d=>{ for(const cid of vis){ const {a,b}=C.bins[cid]; for(let i=0,p=0;i<a.length;i++,p+=4){ const A=a[i],B=b[i]; if(A&&B){ d[p]=CMP_AGREE[0];d[p+1]=CMP_AGREE[1];d[p+2]=CMP_AGREE[2];d[p+3]=150; } else if(A){ d[p]=CMP_AONLY[0];d[p+1]=CMP_AONLY[1];d[p+2]=CMP_AONLY[2];d[p+3]=170; } else if(B){ d[p]=CMP_BONLY[0];d[p+1]=CMP_BONLY[1];d[p+2]=CMP_BONLY[2];d[p+3]=170; } } } });
  } else if(C.mode==='overlay'){
    C.layer=mkLayer(d=>{ for(const cid of vis){ const {a,color}=C.bins[cid]; paintFill(d,a,color,90); } for(const cid of vis){ const {b,color}=C.bins[cid]; paintBoundary(d,b,[255,255,255]); paintBoundary(d,C.bins[cid].a,color); } });
  } else { // dual
    C.layerA=mkLayer(d=>{ for(const cid of vis){ const {a,color}=C.bins[cid]; paintFill(d,a,color,110); paintBoundary(d,a,color); } });
    C.layerB=mkLayer(d=>{ for(const cid of vis){ const {b,color}=C.bins[cid]; paintFill(d,b,color,110); paintBoundary(d,b,color); } });
  }
}
function updateLegend(){
  const L=$('cmpLegend');
  if(C.mode==='diff'){ L.innerHTML=`<span class="lg"><span class="sw" style="background:rgb(${CMP_AGREE})"></span>agree</span><span class="lg"><span class="sw" style="background:rgb(${CMP_AONLY})"></span>${C.a} only</span><span class="lg"><span class="sw" style="background:rgb(${CMP_BONLY})"></span>${C.b} only</span>`; }
  else if(C.mode==='overlay'){ L.innerHTML=`<span class="lg">fill = <b>${C.a}</b> · white outline = <b>${C.b}</b></span>`; }
  else { L.innerHTML=`<span class="lg">left = <b>${C.a}</b> · right = <b>${C.b}</b></span>`; }
}
function compareResize(){
  const st=$('cmpStage'); const dp=window.devicePixelRatio||1;
  cmpCanvas.width=st.clientWidth*dp; cmpCanvas.height=st.clientHeight*dp;
  cctx.setTransform(dp,0,0,dp,0,0);
}
function fitCmp(){
  const st=$('cmpStage'); const vw=st.clientWidth, vh=st.clientHeight;
  const s=Math.min((vw-20)/C.w,(vh-20)/C.h); C.view={scale:s, panX:(vw-C.w*s)/2, panY:(vh-C.h*s)/2};
}
function cmpRender(){
  const st=$('cmpStage'); const vw=st.clientWidth, vh=st.clientHeight;
  cctx.clearRect(0,0,vw,vh);
  if(!C.data) return;
  if(C.mode==='dual'){
    const hw=vw/2;
    drawPanel(0,hw,vh,C.layerA,C.a); drawPanel(hw,hw,vh,C.layerB,C.b);
    cctx.strokeStyle='#232a31'; cctx.lineWidth=1; cctx.beginPath(); cctx.moveTo(hw,0); cctx.lineTo(hw,vh); cctx.stroke();
    return;
  }
  cctx.save(); cctx.translate(C.view.panX,C.view.panY); cctx.scale(C.view.scale,C.view.scale);
  const showImg = C.showFrame && C.img;
  if(showImg){ cctx.imageSmoothingEnabled=true; cctx.drawImage(C.img,0,0,C.w,C.h); }
  cctx.imageSmoothingEnabled=false; cctx.globalAlpha = showImg? 0.55 : 1;
  if(C.layer) cctx.drawImage(C.layer,0,0,C.w,C.h);
  cctx.globalAlpha=1; cctx.restore();
}
function drawPanel(x0,pw,vh,layer,label){
  const s=Math.min((pw-14)/C.w,(vh-24)/C.h); const iw=C.w*s, ih=C.h*s; const ox=x0+(pw-iw)/2, oy=(vh-ih)/2;
  cctx.save(); cctx.beginPath(); cctx.rect(x0,0,pw,vh); cctx.clip();
  const showImg = C.showFrame && C.img;
  if(showImg){ cctx.imageSmoothingEnabled=true; cctx.drawImage(C.img,ox,oy,iw,ih); }
  cctx.imageSmoothingEnabled=false; cctx.globalAlpha = showImg? 0.55 : 1;
  if(layer) cctx.drawImage(layer,ox,oy,iw,ih);
  cctx.globalAlpha=1;
  cctx.fillStyle='rgba(10,12,15,.75)'; cctx.fillRect(x0+8,8,10+label.length*7,18);
  cctx.fillStyle='#dbe1e8'; cctx.font='600 11px Inter, system-ui'; cctx.textAlign='left'; cctx.fillText(label,x0+13,21);
  cctx.restore();
}
function renderCmpClasses(){
  const box=$('cmpClasses'); box.innerHTML='';
  $('cmpAll').checked = C.solo==null && C.data.classes.length>0 && C.data.classes.every(c=>C.visible.has(c.class_id));
  const k=C.classSort.key, dir=C.classSort.dir;
  const cls=[...C.data.classes].sort((a,b)=>{
    if(k==='class_name') return dir*a.class_name.localeCompare(b.class_name);
    const av=a[k], bv=b[k];
    if(av==null) return 1; if(bv==null) return -1;
    return dir*(av-bv);
  });
  for(const cl of cls){
    const on = C.solo!=null? C.solo===cl.class_id : C.visible.has(cl.class_id);
    const el=document.createElement('div'); el.className='cmp-crow'+(C.solo===cl.class_id?' solo':'');
    el.style.opacity = on? '1':'.4';
    const flag = cl.only_a? ` <span class="flag">${C.a}-only</span>` : cl.only_b? ` <span class="flag">${C.b}-only</span>`:'';
    el.innerHTML=`<span class="obj-dot" style="background:rgb(${classColorRGB(cl.class_id)})"></span>
      <span class="cname">${cl.class_name}${flag}</span>
      <span class="cmet">D ${fmtn(cl.dice)}<br>IoU ${fmtn(cl.iou)}${cl.hd95!=null?'<br>HD95 '+cl.hd95:''}</span>`;
    el.addEventListener('click',()=>{ if(C.visible.has(cl.class_id)) C.visible.delete(cl.class_id); else C.visible.add(cl.class_id); C.solo=null; buildCmpLayers(); cmpRender(); renderCmpClasses(); });
    el.addEventListener('dblclick',()=>{ C.solo = C.solo===cl.class_id? null : cl.class_id; buildCmpLayers(); cmpRender(); renderCmpClasses(); });
    box.appendChild(el);
  }
}
// zoom/pan for overlay & diff
cmpCanvas.addEventListener('wheel',e=>{ if(C.mode==='dual'||!C.data) return; e.preventDefault();
  const r=cmpCanvas.getBoundingClientRect(); const cx=e.clientX-r.left, cy=e.clientY-r.top;
  if(e.ctrlKey||e.metaKey){ const f=Math.exp(-e.deltaY*0.0015); const ix=(cx-C.view.panX)/C.view.scale, iy=(cy-C.view.panY)/C.view.scale;
    C.view.scale=clampi(C.view.scale*f,0.1,8); C.view.panX=cx-ix*C.view.scale; C.view.panY=cy-iy*C.view.scale; cmpRender(); }
  else { C.view.panY-=e.deltaY; C.view.panX-=e.deltaX; cmpRender(); } },{passive:false});
cmpCanvas.addEventListener('mousedown',e=>{ if(C.mode==='dual') return; C.panning=true; const r=cmpCanvas.getBoundingClientRect(); C.panStart=[e.clientX-r.left,e.clientY-r.top,C.view.panX,C.view.panY]; cmpCanvas.style.cursor='grabbing'; });
window.addEventListener('mousemove',e=>{ if(!C.panning) return; const r=cmpCanvas.getBoundingClientRect(); C.view.panX=C.panStart[2]+(e.clientX-r.left-C.panStart[0]); C.view.panY=C.panStart[3]+(e.clientY-r.top-C.panStart[1]); cmpRender(); });
window.addEventListener('mouseup',()=>{ if(C.panning){ C.panning=false; cmpCanvas.style.cursor='grab'; } });
window.addEventListener('resize',()=>{ if(C.open){ compareResize(); cmpRender(); } });

// -- import mask / prompts (folder browser, defaults to the configured path) --
/* ---------- sticky import folders ----------
   First use asks for a folder; every later press reuses it silently.
   The folder icon fused into each button re-opens the picker to change it.        */
const LS = {
  get(k){ try{ return localStorage.getItem(k) || null; }catch(_){ return null; } },
  set(k,v){ try{ v? localStorage.setItem(k,v) : localStorage.removeItem(k); }catch(_){} },
};
const IMPORT_KIND = {
  mask:    {key:'issas.maskDir',    state:'maskDir',    btn:'importMaskBtn',
            label:'Import mask',    title:'Choose mask folder (<frame>.png / .txt)'},
  prompts: {key:'issas.promptsDir', state:'promptsDir', btn:'importPromptsBtn',
            label:'Import prompts', title:'Choose Supervisely prompts folder'},
};
S.maskDir    = LS.get(IMPORT_KIND.mask.key);
S.promptsDir = LS.get(IMPORT_KIND.prompts.key);

function setImportDir(kind, dir){
  const K = IMPORT_KIND[kind];
  S[K.state] = dir || null;
  LS.set(K.key, dir || null);
  updateImportBtn(kind);
}
function updateImportBtn(kind){
  const K = IMPORT_KIND[kind], b = $(K.btn); if(!b) return;
  const dir = S[K.state];
  b.classList.toggle('has-dir', !!dir);
  b.title = dir ? `${K.label} from:\n${dir}\n\nPress again to reuse this folder · folder icon to change`
                : `${K.label} — pick a folder the first time, then it is reused`;
}
function updateImportBtns(){ updateImportBtn('mask'); updateImportBtn('prompts'); }

// open the picker; on select remember the folder and (optionally) import straight away
function chooseImportDir(kind, thenImport){
  const K = IMPORT_KIND[kind];
  openBrowser({
    title: K.title,
    start: S[K.state] || $('folderPath').value.trim() || S.defaultPath,
    onSelect: (dir)=>{
      if(!dir) return;
      setImportDir(kind, dir);
      if(thenImport) (kind==='mask'? doImportMask : doImportPrompts)(dir);
      else toast((kind==='mask'?'Mask':'Prompts')+' folder set','ok');
    },
  });
}
function runImport(kind){
  if(!S.count){ toast('Open a folder first'); return; }
  const dir = S[IMPORT_KIND[kind].state];
  if(dir) (kind==='mask'? doImportMask : doImportPrompts)(dir);   // remembered — go straight in
  else chooseImportDir(kind, true);                               // first time — ask, then import
}

$('importMaskBtn').addEventListener('click', ()=>runImport('mask'));
$('importMaskDirBtn').addEventListener('click', e=>{ e.stopPropagation(); chooseImportDir('mask', false); });
$('importPromptsDirBtn').addEventListener('click', e=>{ e.stopPropagation(); chooseImportDir('prompts', false); });

// Drop every object on the current frame: list entries, masks and pending prompts.
function clearAllObjects(){
  S.objects.clear(); S.order=[]; S.currentId=null;
  S.points.clear(); S.boxes.clear();
}
async function importMaskInto(dir, replace){
  const {ok,j}=await API.post('/api/import_mask',{dir, frame_idx:S.idx});
  if(!ok) return {ok:false, n:0, detail:j.detail};   // failed fetch clears nothing
  if(replace){
    clearAllObjects();
    S.rawMasks.delete(S.idx);   // these masks came from disk, so there is no SAM2 proposal behind them
  }
  for(const o of j.objects){ const obj=ensureObject(o.obj_id,o.class_id,o.name,o.color); obj.bin=await pngB64ToBin(o.mask); invalidateTint(obj); }
  if(replace && S.order.length){ rebuildObjList(); selectObject(S.order[0]); }
  return {ok:true, n:j.objects.length};
}
// Importing masks means the frames are already annotated, so propagation would
// overwrite them — but only the FIRST import of a case flips the switch. After that
// the user's own Propagation ON/OFF choice is respected on every repeat import.
async function doImportMask(dir){
  if(!dir) return;
  setImportDir('mask', dir);          // remember whatever folder actually got used
  const before=captureFull();         // pushed only if the import actually replaces anything
  showOverlay('Importing mask…');
  const r=await importMaskInto(dir, true);   // replace: imported mask becomes the whole frame
  hideOverlay();
  if(!r.ok){ toast((r.detail||'import failed')+' — use the folder icon to change','err'); return; }
  pushHistory(before);                // Ctrl+Z now restores the pre-import frame
  if(!importedThisSession){
    importedThisSession=true;
    S.propagation=false; $('propBtn').textContent='Propagation: OFF'; $('propBtn').classList.remove('on');
  }
  S.dirty=true; rebuildObjList(); render(); toast('Imported '+r.n+' masks','ok');
}

$('importPromptsBtn').addEventListener('click', ()=>runImport('prompts'));
async function doImportPrompts(dir){
  if(!dir) return;
  setImportDir('prompts', dir);
  showOverlay('Importing prompts…');
  const {ok,j}=await API.post('/api/import_prompts',{dir, frame_idx:S.idx}); hideOverlay();
  if(!ok){ toast((j.detail||'import failed')+' — use the folder icon to change','err'); return; }
  for(const o of j.current){ const obj=ensureObject(o.obj_id,o.class_id,o.name,o.color); obj.bin=await pngB64ToBin(o.mask); invalidateTint(obj); captureRaw(obj.id, obj.bin, 'prompt', true); }
  rebuildObjList(); render();
  const pend=j.pending_frames&&j.pending_frames.length? ` · ${j.pending_frames.length} frames pending`:'';
  toast(`Imported ${j.current.length} prompts${pend}`,'ok');
}

// -- save --
$('saveBtn').addEventListener('click', saveMasks);
$('exportSamRaw').addEventListener('change', async e=>{
  if(!e.target.checked){
    const okd=await uiConfirm('SAM-raw masks will no longer be saved to the _sam folder. This removes the SAM-vs-human comparison data. Continue?', {title:'Disable SAM-raw saving', okText:'Disable', danger:true});
    if(!okd){ e.target.checked=true; } else { toast('SAM-raw saving disabled','err'); }
  } else { toast('SAM-raw saving enabled','ok'); }
});
$('pngBrowse').addEventListener('click', ()=>openBrowser({title:'Choose PNG output folder', start:$('pngDir').value||S.defaultPath, onSelect:p=>{ if(p) $('pngDir').value=p; }}));
$('yoloBrowse').addEventListener('click', ()=>openBrowser({title:'Choose YOLO output folder', start:$('yoloDir').value||S.defaultPath, onSelect:p=>{ if(p) $('yoloDir').value=p; }}));

// -- frame nav --
$('prevBtn').addEventListener('click',()=>requestFrame(S.idx-1));
$('nextBtn').addEventListener('click',()=>requestFrame(S.idx+1));
$('frameSlider').addEventListener('change',e=>requestFrame(+e.target.value));
$('frameSlider').addEventListener('input',e=>{ $('position').textContent=`${(+e.target.value)+1} / ${S.count}`; });
$('frameSlider').addEventListener('pointermove',showVideoTimelineTip);
$('frameSlider').addEventListener('pointerleave',()=>$('videoTimelineTip').classList.add('hidden'));
$('frameSlider').addEventListener('contextmenu',e=>{
  e.preventDefault(); $('videoTimelineTip').classList.add('hidden'); openContextVideo(timelineIndex(e),true);
});
$('videoOpen').addEventListener('click',()=>openContextVideo(S.idx,true));
$('videoSet').addEventListener('click',configureVideoFolder);
$('videoPath').addEventListener('keydown',e=>{ if(e.key==='Enter') configureVideoFolder(); });
$('videoBrowse').addEventListener('click',()=>openBrowser({title:'Choose context video folder',start:$('videoPath').value||S.defaultPath,onSelect:p=>{ if(p){ $('videoPath').value=p; configureVideoFolder(); } }}));
$('videoClose').addEventListener('click',closeContextVideo);
$('videoPlayPause').addEventListener('click',toggleVideoPlay);
$('videoReplay').addEventListener('click',()=>seekContextVideo(V.clipStart,true));
$('videoPrevFrame').addEventListener('click',()=>stepVideo(-1));
$('videoNextFrame').addEventListener('click',()=>stepVideo(1));
$('videoSeek').addEventListener('input',e=>{ contextVideo.pause(); contextVideo.currentTime=Number(e.target.value); updateVideoControls(); });
$('videoSpeed').addEventListener('change',e=>setVideoPlaybackRate(e.target.value));
contextVideo.addEventListener('click',toggleVideoPlay);
contextVideo.addEventListener('loadedmetadata',()=>{
  setVideoPlaybackRate(V.playbackRate,false);
  if(Number.isFinite(contextVideo.duration)){ V.duration=contextVideo.duration; V.clipEnd=Math.min(V.duration,V.center+10); $('videoSeek').max=V.clipEnd; }
  updateVideoFrameMark();
  if(!V.seekPending) $('videoLoading').classList.add('hidden');
  updateVideoControls();
});
contextVideo.addEventListener('canplay',()=>{ if(!V.seekPending) $('videoLoading').classList.add('hidden'); });
contextVideo.addEventListener('waiting',()=>$('videoLoading').classList.remove('hidden'));
contextVideo.addEventListener('playing',()=>{ if(!V.seekPending) $('videoLoading').classList.add('hidden'); updateVideoControls(); });
contextVideo.addEventListener('pause',updateVideoControls);
contextVideo.addEventListener('timeupdate',()=>{
  if(contextVideo.currentTime>=V.clipEnd-.02 && !contextVideo.paused){ contextVideo.pause(); contextVideo.currentTime=V.clipEnd; }
  updateVideoControls();
});
contextVideo.addEventListener('error',()=>{ $('videoLoading').classList.add('hidden'); toast('The context video could not be decoded','err'); });
document.querySelectorAll('.video-mode').forEach(btn=>btn.addEventListener('click',()=>setVideoMode(btn.dataset.videoMode)));
if(window.ResizeObserver) new ResizeObserver(syncVideoSplitDirection).observe($('videoWindow').closest('.stage'));

// The title bar moves only the floating player. Resize is provided by the window's lower-right edge.
$('videoDragHandle').addEventListener('pointerdown',e=>{
  if(e.button!==0||V.mode!=='float'||e.target.closest('button')) return;
  e.preventDefault();
  const handle=e.currentTarget, pointerId=e.pointerId;
  const win=$('videoWindow'), rect=win.getBoundingClientRect(), dx=e.clientX-rect.left, dy=e.clientY-rect.top;
  let finished=false;
  const finish=()=>{
    if(finished) return;
    finished=true;
    handle.classList.remove('dragging');
    handle.removeEventListener('pointermove',move);
    handle.removeEventListener('pointerup',finish);
    handle.removeEventListener('pointercancel',finish);
    handle.removeEventListener('lostpointercapture',finish);
    window.removeEventListener('pointerup',finish,true);
    window.removeEventListener('blur',finish);
    if(handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
  };
  const move=ev=>{
    if(ev.pointerId!==pointerId) return;
    // Recover even if pointerup happened outside the browser and was never delivered.
    if((ev.buttons&1)===0){ finish(); return; }
    const x=Math.max(0,Math.min(window.innerWidth-win.offsetWidth,ev.clientX-dx));
    const y=Math.max(54,Math.min(window.innerHeight-win.offsetHeight,ev.clientY-dy));
    win.style.left=x+'px'; win.style.top=y+'px'; win.style.right='auto';
  };
  handle.classList.add('dragging');
  handle.setPointerCapture(pointerId);
  handle.addEventListener('pointermove',move);
  handle.addEventListener('pointerup',finish);
  handle.addEventListener('pointercancel',finish);
  handle.addEventListener('lostpointercapture',finish);
  window.addEventListener('pointerup',finish,true);
  window.addEventListener('blur',finish);
});
$('jumpBtn').addEventListener('click',jump);
$('jumpInput').addEventListener('keydown',e=>{ if(e.key==='Enter') jump(); });
function jump(){
  const v=$('jumpInput').value.trim(); if(!v) return;
  let idx=parseInt(v,10)-1;
  if(isNaN(idx)) idx=S.frames.findIndex(n=>n.startsWith(v)||n.split('.')[0]===v);
  if(idx>=0&&idx<S.count) requestFrame(idx); else toast('Frame not found','err');
}

// unsaved-changes guard on frame change
let pendingFrame=null;
function requestFrame(idx){
  idx=clampi(idx,0,S.count-1);
  if(idx===S.idx) return;
  if(S.dirty){
    if(!$('saveReminder').classList.contains('hidden')) return;  // reminder already open
    pendingFrame=idx; $('frameSlider').value=S.idx;
    $('saveReminder').classList.remove('hidden'); return;
  }
  loadFrame(idx);
}
$('remCancel').addEventListener('click',()=>{ pendingFrame=null; $('frameSlider').value=S.idx; $('saveReminder').classList.add('hidden'); });
$('remIgnore').addEventListener('click',()=>{
  $('saveReminder').classList.add('hidden'); S.dirty=false;
  const t=pendingFrame; pendingFrame=null; if(t!=null) loadFrame(t);
});
$('remSave').addEventListener('click',()=>{ $('saveReminder').classList.add('hidden'); saveMasks(); });

// -- keyboard --
window.addEventListener('keydown',(e)=>{
  // fullscreen first: it must work even while a path field has focus, and the
  // browser's own Ctrl+F find bar is useless in this tool
  if((e.ctrlKey||e.metaKey) && (e.key==='f'||e.key==='F')){ e.preventDefault(); toggleFullscreen(); return; }
  if(e.code==='Space'){ S.spaceDown=true; if(!S.brushing&&!S.dragBox) canvas.style.cursor='grab'; }
  const tag=document.activeElement.tagName;
  if(tag==='INPUT'||tag==='TEXTAREA') return;
  // when the Compare window is open, A/D drive its frames
  if(C.open){
    const k=e.key.toLowerCase();
    if(k==='a'){ loadCmpFrame(C.idx-1); e.preventDefault(); return; }
    if(k==='d'){ loadCmpFrame(C.idx+1); e.preventDefault(); return; }
    if(e.key==='Escape'){ $('compareModal').classList.add('hidden'); C.open=false; return; }
    return;
  }
  if(e.ctrlKey||e.metaKey){
    if(e.key==='z'){ e.preventDefault(); undo(); return; }
    if(e.key==='s'){ e.preventDefault(); saveMasks(); return; }
  }
  switch(e.key.toLowerCase()){
    case 'a': requestFrame(S.idx-1); break;
    case 'd': requestFrame(S.idx+1); break;
    case 'w': cycleObject(-1); break;
    case 's': cycleObject(1); break;
    case 'q': $('importMaskBtn').click(); break;
    case 'g': applyPP('gaussian'); break;
    case 'f': applyPP('morph'); break;
    case 'h': applyPP('components'); break;
    case 'b': $('brushBtn').click(); break;
    case 't': { const o=S.objects.get(S.currentId); if(o){o.visible=!o.visible; rebuildObjList(); render();} break; }
    case 'y': S.vis.all=!S.vis.all; render(); break;
    case 'p': reseedFromHere(); break;
    case '[': togglePanel('left'); break;
    case ']': togglePanel('right'); break;
    case '\\': togglePanel('bottom'); break;
    case 'r': { const id=S.currentId; if(id!=null){ snapshot(); S.points.delete(id); S.boxes.delete(id);
                const o=S.objects.get(id); o.bin=new Uint8Array(S.W*S.H); invalidateTint(o); S.dirty=true; render(); } break; }
  }
});
window.addEventListener('keyup',(e)=>{ if(e.code==='Space'){ S.spaceDown=false; canvas.style.cursor=S.brush?'none':'crosshair'; } });

// ---------- folder browser (server-side directory picker) ----------
let browseCurrent=null, browseOnSelect=null, browseExts=null;
async function openBrowser(opts){
  opts=opts||{};
  browseOnSelect=opts.onSelect||null;
  browseExts=opts.exts||null;                 // when set, files are listed and pickable
  $('browserTitle').textContent=opts.title||'Select frame folder';
  $('browserSelect').style.display = browseExts? 'none' : '';   // file mode: pick a file, not the folder
  const start=('start' in opts)? opts.start : ($('folderPath').value.trim()||null);
  await loadBrowse(start);
  $('browser').classList.remove('hidden');
  // must run AFTER the modal is visible: while it is display:none the textarea's
  // scrollHeight is 0, which would collapse the field and clip the path
  autoSizePath();
}
async function loadBrowse(path){
  const {ok,j}=await API.post('/api/browse',{path, exts:browseExts});
  if(!ok){ toast(j.detail||'cannot open path','err'); return; }
  browseCurrent=j.path;
  $('browserPath').value=j.path;
  $('browserPath').title=j.path;
  autoSizePath();
  const info=$('browserInfo');
  if(browseExts){ const n=(j.files||[]).length; info.textContent=`${n} matching file${n===1?'':'s'} · click one to pick`; info.classList.toggle('browser-info-ok', n>0); }
  else if(j.image_count>0){ info.textContent=`${j.image_count} images in this folder`; info.classList.add('browser-info-ok'); }
  else { info.textContent='no images in this folder'; info.classList.remove('browser-info-ok'); }
  const list=$('browserList'); list.innerHTML='';
  if(j.parent){
    const up=document.createElement('div'); up.className='browser-row up';
    up.innerHTML='<span class="ico">↑</span><span>..</span>';
    up.addEventListener('click',()=>loadBrowse(j.parent)); list.appendChild(up);
  }
  for(const d of j.dirs){
    const row=document.createElement('div'); row.className='browser-row';
    row.innerHTML=`<span class="ico">▸</span><span>${d}</span>`;
    const child=(j.path.replace(/\/+$/,''))+'/'+d;
    row.addEventListener('click',()=>loadBrowse(child));
    list.appendChild(row);
  }
  for(const f of (j.files||[])){
    const row=document.createElement('div'); row.className='browser-row file';
    row.innerHTML=`<span class="ico">📄</span><span>${f}</span>`;
    const fp=(j.path.replace(/\/+$/,''))+'/'+f;
    row.addEventListener('click',()=>{ $('browser').classList.add('hidden'); const cb=browseOnSelect; browseOnSelect=null; if(cb) cb(fp); });
    list.appendChild(row);
  }
}
$('browseBtn').addEventListener('click', ()=>openBrowser());
// the path field is a textarea so long paths wrap; grow it to fit (capped by CSS max-height)
function autoSizePath(){
  const el=$('browserPath'); if(!el) return;
  if(!el.offsetParent) return;          // hidden: scrollHeight would be 0 and collapse the field
  el.style.height='auto';
  el.style.height=el.scrollHeight+'px';
}
$('browserPath').addEventListener('input', autoSizePath);
function browserGoToTyped(){
  const p=$('browserPath').value.replace(/[\r\n]+/g,'').trim().replace(/\\/g,'/');
  if(p) loadBrowse(p);
}
$('browserPath').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); browserGoToTyped(); } });
$('browserPathGo').addEventListener('click', browserGoToTyped);
$('browserPathCopy').addEventListener('click', ()=>{
  const p=(browseCurrent||'').replace(/\\/g,'/'); if(!p) return;
  (navigator.clipboard? navigator.clipboard.writeText(p) : Promise.reject())
    .then(()=>toast('Path copied','ok'))
    .catch(()=>{ const t=document.createElement('textarea'); t.value=p; document.body.appendChild(t); t.select(); try{document.execCommand('copy'); toast('Path copied','ok');}catch(_){toast('Copy failed','err');} t.remove(); });
});
$('browserNewFolder').addEventListener('click', async ()=>{
  if(!browseCurrent){ return; }
  const name=await uiPrompt('New folder name (created inside the current folder):', {title:'New folder', okText:'Create'});
  if(!name) return;
  const {ok,j}=await API.post('/api/mkdir',{parent:browseCurrent, name});
  if(!ok){ toast(j.detail||'could not create folder','err'); return; }
  loadBrowse(j.path);   // navigate into the new folder
  toast('Created '+name,'ok');
});
$('browserClose').addEventListener('click',()=>$('browser').classList.add('hidden'));
$('browser').addEventListener('click',e=>{ if(e.target.id==='browser') $('browser').classList.add('hidden'); });
$('browserSelect').addEventListener('click',()=>{
  const path=browseCurrent;
  $('browser').classList.add('hidden');
  if(browseOnSelect){ const cb=browseOnSelect; browseOnSelect=null; cb(path); }
  else { if(path) $('folderPath').value=path; toast('Path set — click Open folder','ok'); }
});

// ---------- File-tree drawer ----------
function setDrawer(folded){
  const d=$('fileDrawer'); d.classList.toggle('folded', folded);
  if(!folded && !$('fdTree').dataset.loaded) loadTreeRoot();
  // reflow the canvas to the new width (mid + end of the width transition)
  requestAnimationFrame(resizeCanvas);
  setTimeout(resizeCanvas, 160);
}
$('filesToggle').addEventListener('click', ()=>setDrawer(!$('fileDrawer').classList.contains('folded')));
$('fdFold').addEventListener('click', ()=>setDrawer(true));
$('fdTab').addEventListener('click', ()=>setDrawer(false));
$('fdUp').addEventListener('click', ()=>{
  const r=$('fdRoot').value.trim().replace(/\/+$/,''); const p=r.replace(/\/[^\/]*$/,'')||'/';
  $('fdRoot').value=p; $('fdTree').dataset.loaded=''; renderTreeRoot(p);
});
$('fdRootBrowse').addEventListener('click', ()=>openBrowser({title:'Choose data root', start:$('fdRoot').value||null, onSelect:p=>{ if(p){ $('fdRoot').value=p; $('fdTree').dataset.loaded=''; renderTreeRoot(p); } }}));
$('fdRootSet').addEventListener('click', ()=>{ $('fdTree').dataset.loaded=''; renderTreeRoot($('fdRoot').value.trim()); });
$('userField').addEventListener('change', e=>{ S.user=e.target.value.trim()||'ISSAS_USER'; });

// ---------- Setup panel: classes + model ----------
$('setupToggle').addEventListener('click', ()=>{ $('setupToggle').classList.toggle('open'); $('setupBody').classList.toggle('hidden'); });
function resetAnnotationState(){
  S.objects.clear(); S.order=[]; S.currentId=null; S.frameMasks.clear(); S.rawMasks.clear();
  S.dirty=false; rebuildObjList(); render();
}
function applyClasses(j, source){
  S.classMap={...(j.class_map||{})};
  S.classGroups={tissue:j.tissue||{}, instrument:j.instrument||{}};
  if(source!==undefined) S.classSource=source;
  updateClassBadge();
  resetAnnotationState();
}
function updateClassBadge(){
  const names=Object.keys(S.classMap); const n=names.length;
  $('classInfo').textContent=`${n} classes`;
  const b=$('setupClasses'); if(b){
    b.textContent=`${S.classSource||'classes'} · ${n}`;
    b.title=`Active class set: ${S.classSource||'—'} (${n} classes)\n`+names.join(', ');
  }
}
$('classFileBtn').addEventListener('click', ()=>$('classFile').click());
$('classBrowseBtn').addEventListener('click', ()=>openBrowser({title:'Choose class file (.json / .yaml)', exts:['.json','.yaml','.yml'], start:$('fdRoot').value||S.defaultPath, onSelect:async p=>{
  const {ok,j}=await API.post('/api/classes/load',{path:p});
  if(!ok){ toast(j.detail||'class load failed','err'); return; }
  applyClasses(j, p.replace(/\\/g,'/').split('/').pop()); toast(`Loaded ${j.n} classes — annotations reset`,'ok');
}}));
$('modelBrowseBtn').addEventListener('click', ()=>{ const cur=$('modelPath').value.trim(); const start=cur? cur.replace(/\/[^\/]*$/,''):(S.defaultPath); openBrowser({title:'Choose SAM checkpoint (.pt)', exts:['.pt','.pth'], start, onSelect:p=>{ $('modelPath').value=p; }}); });
$('modelCfgBrowseBtn').addEventListener('click', ()=>{ const cur=$('modelCfg').value.trim(); const start=cur? cur.replace(/\/[^\/]*$/,''):(S.defaultPath); openBrowser({title:'Choose model config (.yaml)', exts:['.yaml','.yml'], start, onSelect:p=>{ $('modelCfg').value=p; }}); });
$('classFile').addEventListener('change', async e=>{
  const f=e.target.files[0]; if(!f) return;
  const text=await f.text();
  const fmt=/\.ya?ml$/i.test(f.name)?'yaml':'json';
  const {ok,j}=await API.post('/api/classes/load',{text, format:fmt});
  e.target.value='';
  if(!ok){ toast(j.detail||'class load failed','err'); return; }
  applyClasses(j, f.name); toast(`Loaded ${j.n} classes — annotations reset`,'ok');
});
$('classResetBtn').addEventListener('click', async ()=>{
  const {ok,j}=await API.post('/api/classes/reset',{});
  if(!ok){ toast('reset failed','err'); return; }
  applyClasses(j, 'Gastro28 (default)'); toast('Classes reset to default','ok');
});
$('modelLoadBtn').addEventListener('click', async ()=>{
  const ckpt=$('modelPath').value.trim().replace(/\\/g,'/'); if(!ckpt){ toast('Enter a checkpoint path','err'); return; }
  const config=$('modelCfg').value.trim().replace(/\\/g,'/')||null;
  if(!await uiConfirm('Load a new SAM model? This clears SAM memory and resets the current annotations.', {title:'Load model', okText:'Load'})) return;
  showOverlay('Loading model…');
  const {ok,j}=await API.post('/api/model/load',{ckpt, config});
  if(!ok){ hideOverlay(); toast(j.detail||'model load failed','err'); return; }
  if(S.count>0){ $('overlayText').textContent='Re-initializing on current frames…'; await API.post('/api/init',{}); }
  hideOverlay();
  S.sam2=true; $('modeBadge').textContent=`SAM · ${S.device||'cuda'}`; $('modeBadge').className='badge badge-live';
  $('modelInfo').textContent='loaded';
  resetAnnotationState();
  toast('Model loaded — annotations reset','ok');
});

async function loadTreeRoot(){
  let root=$('fdRoot').value.trim();
  if(!root){ try{ const r=await API.get('/api/tree_root'); root=r.root; $('fdRoot').value=root; }catch(_){} }
  renderTreeRoot(root);
}
async function renderTreeRoot(root){
  if(!root) return;
  const box=$('fdTree'); box.innerHTML=''; box.dataset.loaded='1';
  const node=await buildTreeNode(root, (root.replace(/\/+$/,'').split('/').pop()||root), 0);
  box.appendChild(node);
  const arrow=node.querySelector('.tree-arrow'); if(arrow) arrow.click();  // auto-expand root
}
async function buildTreeNode(path, name, depth){
  const node=document.createElement('div'); node.className='tree-node';
  const row=document.createElement('div'); row.className='tree-row';
  row.innerHTML=`<span class="tree-arrow">▶</span><span class="tree-ico">📁</span><span class="tree-name" title="${name}">${name}</span><span class="tree-load" title="Load images from this folder">load</span>`;
  const children=document.createElement('div'); children.className='tree-children hidden';
  node.appendChild(row); node.appendChild(children);
  const arrow=row.querySelector('.tree-arrow');
  let loaded=false;
  async function expand(){
    if(!loaded){
      loaded=true;
      const {ok,j}=await API.post('/api/tree',{path});
      if(!ok){ toast(j.detail||'cannot read folder','err'); return; }
      if(!j.dirs.length && !j.images.length){ children.innerHTML='<div class="tree-row leaf"><span class="tree-ico">·</span><span class="tree-name">(empty)</span></div>'; }
      for(const d of j.dirs){ children.appendChild(await buildTreeNode(d.path, d.name, depth+1)); }
      for(const im of j.images.slice(0,200)){ const l=document.createElement('div'); l.className='tree-row leaf'; l.innerHTML=`<span class="tree-arrow"></span><span class="tree-ico">🖼</span><span class="tree-name">${im}</span>`; children.appendChild(l); }
      if(j.images.length>200){ const more=document.createElement('div'); more.className='tree-row leaf'; more.innerHTML=`<span class="tree-arrow"></span><span class="tree-ico">…</span><span class="tree-name">+${j.images.length-200} more images</span>`; children.appendChild(more); }
    }
    children.classList.toggle('hidden'); arrow.classList.toggle('open', !children.classList.contains('hidden'));
  }
  arrow.addEventListener('click', e=>{ e.stopPropagation(); expand(); });
  row.addEventListener('dblclick', ()=>expand());   // double-click just folds/unfolds children
  row.querySelector('.tree-load').addEventListener('click', e=>{ e.stopPropagation(); confirmLoad(path); });
  row.addEventListener('contextmenu', e=>{ e.preventDefault(); showTreeCtx(e.clientX, e.clientY, path); });
  return node;
}
async function confirmLoad(path){
  const warn = S.dirty? ' You have unsaved edits that will be discarded.' : '';
  if(await uiConfirm(`Load images from: ${path}. This clears SAM memory and starts a new case.${warn}`, {title:'Load images', okText:'Load'})) loadImagesHere(path);
}
function showTreeCtx(x,y,path){
  const m=$('fdContextMenu');
  m.innerHTML=`<button id="ctxLoad">Load images here</button><button id="ctxNew">New folder…</button>`;
  m.style.left=x+'px'; m.style.top=y+'px'; m.classList.remove('hidden');
  $('ctxLoad').onclick=()=>{ m.classList.add('hidden'); confirmLoad(path); };
  $('ctxNew').onclick=async ()=>{ m.classList.add('hidden'); const name=await uiPrompt('New folder name:', {title:'New folder', okText:'Create'}); if(!name) return;
    const {ok,j}=await API.post('/api/mkdir',{parent:path, name}); if(ok){ $('fdTree').dataset.loaded=''; renderTreeRoot($('fdRoot').value.trim()); toast('Created '+name,'ok'); } else toast(j.detail||'failed','err'); };
}
document.addEventListener('click', ()=>$('fdContextMenu').classList.add('hidden'));

async function loadImagesHere(path){
  if(await loadFolderIntoEditor(path)){
    setDefaultExportDirs(path);
    S.idx=0; await loadFrame(0,{force:true, noProp:true}); fitViewSoon();
    setDrawer(true);
    toast('Loaded '+S.count+' frames (SAM reset)','ok');
  }
}

// ---------- init ----------
(async function init(){
  applyLayout(false);          // restore saved panel widths / collapse state first
  syncFsBtn();
  fitLegendSoon();
  if(document.fonts && document.fonts.ready) document.fonts.ready.then(fitLegendSoon);
  resizeCanvas();
  updateImportBtns();          // restore remembered mask / prompts folders
  try{ const c=await API.get('/api/classes');
    S.classMap={...(c.class_map||{})};
    S.classGroups={tissue:c.tissue||{}, instrument:c.instrument||{}};
    S.classSource='Gastro28 (default)'; updateClassBadge();
  }catch(_){}
  try{ const m=await API.get('/api/model/current');
    if(m.ckpt) $('modelPath').value=m.ckpt;
    if(m.config) $('modelCfg').value=m.config;
    $('modelInfo').textContent = m.available? 'active' : (m.torch?'not loaded':'no torch');
  }catch(_){}
  try{ const d=await API.get('/api/default_path');
    S.defaultPath=d.path||null;
    if(d.path && !$('folderPath').value) $('folderPath').value=d.path;
  }catch(_){}
  try{ const u=await API.get('/api/user'); S.user=u.user||'ISSAS_USER'; $('userField').value=S.user; }catch(_){ $('userField').value=S.user; }
  try{ const r=await API.get('/api/tree_root'); if(!$('fdRoot').value) $('fdRoot').value=r.root; }catch(_){}
  try{
    const savedPath=localStorage.getItem('issas.videoPath')||'';
    localStorage.removeItem('issas.videoFps');
    if(savedPath){
      $('videoPath').value=savedPath; $('videoFps').value='';
      const {ok,j}=await API.post('/api/video/config',{path:savedPath,fps:null});
      if(ok) applyVideoStatus(j); else applyVideoStatus(await API.get('/api/video/status'));
    } else applyVideoStatus(await API.get('/api/video/status'));
  }catch(_){}
})();
