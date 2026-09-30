import { createClient } from '@supabase/supabase-js';
import './style.css';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!url || !key) throw new Error('Supabase environment variables are missing.');
const supabase = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });

const LANES = [['todo','To do'],['doing','In progress'],['done','Done']];
const state = { user:null, profile:null, boards:[], board:null, cards:new Map(), channel:null };
const $ = s => document.querySelector(s);
const esc = v => String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const id = () => crypto.randomUUID();

function shell(html){ $('#app').innerHTML=html; }
function toast(message){ const e=document.createElement('div'); e.className='toast'; e.textContent=message; document.body.append(e); setTimeout(()=>e.remove(),3500); }
function busy(button,on){ if(!button)return; if(on){button.disabled=true;button.dataset.label=button.textContent;button.textContent='Working…';}else{button.disabled=false;button.textContent=button.dataset.label||button.textContent;} }

async function ensureProfile(){
  const {data:{user}}=await supabase.auth.getUser(); state.user=user;
  if(!user)return;
  let r=await supabase.from('profiles').select('id,display_name').eq('id',user.id).maybeSingle();
  if(r.error)throw r.error;
  if(!r.data){
    const name=(user.user_metadata?.display_name||user.email?.split('@')[0]||'User').trim().slice(0,50);
    r=await supabase.from('profiles').insert({id:user.id,display_name:name}).select('id,display_name').single();
    if(r.error)throw r.error;
  }
  state.profile=r.data;
}

function authView(){
  shell('<main class="auth"><section class="auth-card"><div class="brand">Tackboard</div><p class="muted">Real-time collaborative project boards.</p><div class="tabs"><button class="tab active" data-mode="signin">Sign in</button><button class="tab" data-mode="signup">Create account</button></div><form id="auth-form"><label>Email<input id="email" type="email" required autocomplete="email"></label><label>Password<input id="password" type="password" minlength="8" required autocomplete="current-password"></label><label id="name-row" class="hidden">Display name<input id="name" maxlength="50" autocomplete="name"></label><button class="primary" type="submit">Sign in</button></form><p id="auth-note" class="muted small"></p></section></main>');
  let mode='signin';
  const setMode=m=>{mode=m;document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.dataset.mode===m));$('#name-row').classList.toggle('hidden',m!=='signup');$('#auth-form .primary').textContent=m==='signup'?'Create account':'Sign in';$('#password').autocomplete=m==='signup'?'new-password':'current-password';$('#auth-note').textContent=m==='signup'?'Use a real email. You may need to confirm it before signing in.':''};
  document.querySelectorAll('.tab').forEach(x=>x.onclick=()=>setMode(x.dataset.mode));
  $('#auth-form').onsubmit=async e=>{e.preventDefault();const b=e.submitter;busy(b,true);try{const email=$('#email').value.trim(),password=$('#password').value,name=$('#name').value.trim();const r=mode==='signup'?await supabase.auth.signUp({email,password,options:{data:{display_name:name||email.split('@')[0]}}}):await supabase.auth.signInWithPassword({email,password});if(r.error)throw r.error;if(mode==='signup'&&!r.data.session){$('#auth-note').textContent='Account created. Check your email, confirm it, then sign in.';return}await start()}catch(err){toast(err.message)}finally{busy(b,false)}};
}

async function loadBoards(){
  const r=await supabase.from('boards').select('id,name,owner_id,created_at,board_members!inner(user_id,role)').eq('board_members.user_id',state.user.id).order('created_at',{ascending:false});
  if(r.error)throw r.error; state.boards=r.data||[];
}
async function createBoard(name){
  const r=await supabase.rpc('create_board',{p_name:name||'Untitled board'}); if(r.error)throw r.error;
  const b=r.data?.[0]; if(!b)throw new Error('Board creation failed.');
  localStorage.setItem('tb-share-'+b.id,b.share_token); await loadBoards(); return b.id;
}
async function joinBoard(boardId,token){
  const r=await supabase.rpc('join_board',{p_board_id:boardId,p_token:token}); if(r.error)throw r.error;
  localStorage.setItem('tb-share-'+boardId,token); await loadBoards();
}

function dashboard(){
  shell('<main class="dashboard"><header class="top"><div><div class="brand">Tackboard</div><div class="muted">Your boards</div></div><div class="actions"><span class="muted">'+esc(state.profile.display_name)+'</span><button id="signout" class="ghost">Sign out</button></div></header><section class="boards"><div class="create"><input id="board-name" maxlength="80" placeholder="New board name"><button id="create" class="primary">Create board</button></div>'+state.boards.map(b=>'<button class="board-item" data-id="'+b.id+'"><strong>'+esc(b.name)+'</strong><span>'+(b.board_members?.[0]?.role==='owner'?'Owner':'Member')+'</span></button>').join('')+'</section></main>');
  $('#signout').onclick=signout;
  $('#create').onclick=async()=>{try{const boardId=await createBoard($('#board-name').value.trim());openBoard(boardId)}catch(e){toast(e.message)}};
  document.querySelectorAll('.board-item').forEach(b=>b.onclick=()=>openBoard(b.dataset.id));
}

async function openBoard(boardId){
  state.board=state.boards.find(b=>b.id===boardId)||state.board; if(!state.board)return dashboard();
  history.replaceState(null,'','#'+boardId);
  const r=await supabase.from('cards').select('id,board_id,col,title,description,pos,created_by,updated_at').eq('board_id',boardId).order('pos',{ascending:true});
  if(r.error)throw r.error; state.cards=new Map((r.data||[]).map(c=>[c.id,c])); renderBoard(); subscribe();
}
function renderBoard(){
  shell('<header class="top board-top"><div class="left"><button id="back" class="ghost">← Boards</button><input id="board-title" maxlength="80" value="'+esc(state.board.name)+'" aria-label="Board name"></div><div class="actions"><span id="presence" class="pill">Connecting…</span><button id="share" class="ghost">Share</button><button id="signout" class="ghost">Sign out</button></div></header><main id="lanes" class="kanban"></main>');
  $('#back').onclick=()=>{if(state.channel)supabase.removeChannel(state.channel);state.channel=null;state.board=null;dashboard()};
  $('#signout').onclick=signout;
  $('#share').onclick=shareBoard;
  $('#board-title').onchange=async e=>{const name=e.target.value.trim();if(!name)return;const r=await supabase.from('boards').update({name}).eq('id',state.board.id).eq('owner_id',state.user.id);if(r.error)toast(r.error.message);else{state.board.name=name;await loadBoards()}};
  buildLanes(); renderCards();
}
function buildLanes(){
  $('#lanes').replaceChildren(...LANES.map(([col,label])=>{
    const s=document.createElement('section');
    s.className='lane';s.dataset.col=col;
    s.innerHTML='<h2>'+label+'<small>0</small></h2><div class="cards"></div><form class="add-form"><input maxlength="200" placeholder="Add a card"><button type="submit">+</button></form>';
    const cards=s.querySelector('.cards');
    s.ondragover=e=>{e.preventDefault();e.dataTransfer.dropEffect='move'};
    s.ondrop=e=>{
      e.preventDefault();
      const moving=e.dataTransfer.getData('text/plain');
      if(!moving)return;
      const current=state.cards.get(moving);
      if(!current)return;
      const laneCards=[...state.cards.values()].filter(c=>c.col===col&&c.id!==moving);
      const pos=laneCards.length?Math.max(...laneCards.map(c=>c.pos))+1:1;
      moveCard(moving,col,pos);
    };
    s.querySelector('form').onsubmit=e=>{e.preventDefault();const input=e.currentTarget.querySelector('input'),title=input.value.trim();if(title)createCard(col,title);input.value=''};
    return s;
  }));
}
function renderCards(){
  for(const [col] of LANES){const lane=document.querySelector('.lane[data-col="'+col+'"]');if(!lane)continue;const cards=[...state.cards.values()].filter(c=>c.col===col).sort((a,b)=>a.pos-b.pos||a.id.localeCompare(b.id));lane.querySelector('small').textContent=cards.length;lane.querySelector('.cards').replaceChildren(...cards.map(cardEl));}
}
function cardEl(c){
  const e=document.createElement('article');e.className='card';e.draggable=true;e.dataset.id=c.id;
  const title=document.createElement('p');title.className='title';title.textContent=c.title;title.tabIndex=0;
  const del=document.createElement('button');del.className='x';del.textContent='×';del.setAttribute('aria-label','Delete '+c.title);del.onclick=()=>deleteCard(c);
  e.append(title,del);title.ondblclick=()=>editCard(c,title);
  e.ondragstart=x=>{x.dataTransfer.effectAllowed='move';x.dataTransfer.setData('text/plain',c.id);e.classList.add('dragging')};
  e.ondragend=()=>e.classList.remove('dragging');
  e.ondragover=x=>{x.preventDefault();x.dataTransfer.dropEffect='move'};
  e.ondrop=x=>{x.preventDefault();x.stopPropagation();const moving=x.dataTransfer.getData('text/plain');if(moving&&moving!==c.id)moveCard(moving,c.col,c.pos-0.5)};
  return e;
}
function editCard(c,node){
  const input=document.createElement('input');input.value=c.title;input.maxLength=200;node.replaceWith(input);input.focus();input.select();let done=false;
  const finish=save=>{if(done)return;done=true;input.onblur=null;const value=input.value.trim();if(save&&value&&value!==c.title)updateCard(c,{title:value});else renderCards()};
  input.onkeydown=e=>{if(e.key==='Enter')finish(true);if(e.key==='Escape')finish(false)};input.onblur=()=>finish(true);
}
async function createCard(col,title){
  const old=[...state.cards.values()].filter(c=>c.col===col);const pos=old.length?Math.max(...old.map(c=>c.pos))+1:1;
  const card={id:id(),board_id:state.board.id,col,title,description:'',pos,created_by:state.user.id,updated_at:new Date().toISOString()};state.cards.set(card.id,card);renderCards();
  const r=await supabase.from('cards').insert(card);if(r.error){state.cards.delete(card.id);renderCards();toast(r.error.message)}
}
async function updateCard(c,patch){
  const before={...c};Object.assign(c,patch);renderCards();const r=await supabase.from('cards').update(patch).eq('id',c.id).eq('board_id',state.board.id);if(r.error){Object.assign(c,before);renderCards();toast(r.error.message)}
}
async function moveCard(cardId,col,pos){
  const c=state.cards.get(cardId);if(!c)return;const before={...c};Object.assign(c,{col,pos});renderCards();const r=await supabase.from('cards').update({col,pos}).eq('id',cardId).eq('board_id',state.board.id);if(r.error){Object.assign(c,before);renderCards();toast(r.error.message)}
}
async function deleteCard(c){
  state.cards.delete(c.id);renderCards();const r=await supabase.from('cards').delete().eq('id',c.id).eq('board_id',state.board.id);if(r.error){state.cards.set(c.id,c);renderCards();toast(r.error.message)}
}
async function shareBoard(){
  try{let token=localStorage.getItem('tb-share-'+state.board.id);if(!token){const r=await supabase.rpc('rotate_share_token',{p_board_id:state.board.id});if(r.error)throw r.error;token=r.data;localStorage.setItem('tb-share-'+state.board.id,token)}const link=location.origin+location.pathname+'#'+state.board.id+'?key='+encodeURIComponent(token);await navigator.clipboard.writeText(link);toast('Share link copied')}catch(e){toast(e.message)}
}
function subscribe(){
  if(state.channel)supabase.removeChannel(state.channel);
  const boardId=state.board.id;
  const ch=supabase.channel('board:'+boardId,{config:{private:true,presence:{key:state.user.id}}})
    .on('postgres_changes',{event:'*',schema:'public',table:'cards',filter:'board_id=eq.'+boardId},p=>{if(p.eventType==='DELETE')state.cards.delete(p.old.id);else state.cards.set(p.new.id,p.new);renderCards()})
    .on('presence',{event:'sync'},()=>renderPresence(ch.presenceState()))
    .on('presence',{event:'join'},()=>renderPresence(ch.presenceState()))
    .on('presence',{event:'leave'},()=>renderPresence(ch.presenceState()))
    .subscribe(async status=>{if(status==='SUBSCRIBED'){renderPresence(ch.presenceState());await ch.track({name:state.profile.display_name})}else if(status==='CHANNEL_ERROR')toast('Realtime connection failed')});
  state.channel=ch;
}
function renderPresence(presence){const names=Object.values(presence).flat();const e=$('#presence');if(e)e.textContent=names.length+' online';}
async function signout(){if(state.channel)await supabase.removeChannel(state.channel);await supabase.auth.signOut();location.hash='';state.user=null;state.board=null;authView()}

async function start(){
  await ensureProfile(); await loadBoards();
  const raw=location.hash.slice(1), parts=raw.split('?'), boardId=parts[0], token=new URLSearchParams(parts[1]||'').get('key');
  if(boardId&&token)try{await joinBoard(boardId,token)}catch(e){toast(e.message)}
  await loadBoards();
  const chosen=boardId&&state.boards.some(b=>b.id===boardId)?boardId:state.boards[0]?.id;
  if(chosen)await openBoard(chosen);else dashboard();
}

supabase.auth.onAuthStateChange((_event,session)=>{if(!session){state.user=null;state.board=null;authView()}});
(async()=>{try{const {data:{session}}=await supabase.auth.getSession();if(session)await start();else authView()}catch(e){toast(e.message);authView()}})();
