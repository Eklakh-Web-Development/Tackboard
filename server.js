// Tackboard production server: authenticated realtime collaboration + SQLite persistence.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';

const dir=path.dirname(fileURLToPath(import.meta.url));
const PORT=Number(process.env.PORT||3000);
const DB_PATH=process.env.DB_PATH||path.join(dir,'data','board.db');
const ALLOWED_ORIGIN=process.env.ALLOWED_ORIGIN||'';
const COLS=['todo','doing','done'];
const COLORS=['#2C56E8','#C9461A','#2E8B6A','#8A3FBF','#B0871A','#0F8FA8'];
const MAX_BODY=32*1024;

fs.mkdirSync(path.dirname(DB_PATH),{recursive:true});
const db=new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(
'CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,created_at TEXT DEFAULT (datetime("now")));'+
'CREATE TABLE IF NOT EXISTS boards(id TEXT PRIMARY KEY,name TEXT NOT NULL DEFAULT "Untitled",share_token_hash TEXT NOT NULL UNIQUE,version INTEGER NOT NULL DEFAULT 0,owner_id TEXT NOT NULL,created_at TEXT DEFAULT (datetime("now")),FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE);'+
'CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY,board TEXT NOT NULL,col TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT "",pos REAL NOT NULL,FOREIGN KEY(board) REFERENCES boards(id) ON DELETE CASCADE);'+
'CREATE INDEX IF NOT EXISTS cards_board ON cards(board);'+
'CREATE TABLE IF NOT EXISTS board_members(board TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL DEFAULT "editor" CHECK(role IN ("owner","editor")),PRIMARY KEY(board,user_id),FOREIGN KEY(board) REFERENCES boards(id) ON DELETE CASCADE,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);'+
'CREATE TABLE IF NOT EXISTS activity_log(id INTEGER PRIMARY KEY AUTOINCREMENT,board TEXT NOT NULL,user_id TEXT,action TEXT NOT NULL,detail TEXT,created_at TEXT DEFAULT (datetime("now")),FOREIGN KEY(board) REFERENCES boards(id) ON DELETE CASCADE,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL);'+
'CREATE INDEX IF NOT EXISTS activity_board ON activity_log(board);'
);
const q={
 userByToken:db.prepare('SELECT id,name FROM users WHERE token_hash=?'),
 insertUser:db.prepare('INSERT INTO users(id,name,token_hash) VALUES(?,?,?)'),
 boardByShare:db.prepare('SELECT id,name,version,owner_id FROM boards WHERE share_token_hash=?'),
 insertBoard:db.prepare('INSERT INTO boards(id,name,share_token_hash,owner_id) VALUES(?,?,?,?)'),
 listBoards:db.prepare('SELECT b.id,b.name,b.version,b.created_at,m.role FROM boards b JOIN board_members m ON m.board=b.id WHERE m.user_id=? ORDER BY b.created_at DESC'),
 addMember:db.prepare('INSERT OR IGNORE INTO board_members(board,user_id,role) VALUES(?,?,?)'),
 member:db.prepare('SELECT role FROM board_members WHERE board=? AND user_id=?'),
 cards:db.prepare('SELECT id,col,title,description,pos FROM cards WHERE board=? ORDER BY col,pos,id'),
 hasCard:db.prepare('SELECT 1 FROM cards WHERE id=? AND board=?'),
 insertCard:db.prepare('INSERT OR IGNORE INTO cards(id,board,col,title,description,pos) VALUES(?,?,?,?,?,?)'),
 updateCard:db.prepare('UPDATE cards SET title=COALESCE(?,title),description=COALESCE(?,description) WHERE id=? AND board=?'),
 moveCard:db.prepare('UPDATE cards SET col=?,pos=? WHERE id=? AND board=?'),
 deleteCard:db.prepare('DELETE FROM cards WHERE id=? AND board=?'),
 version:db.prepare('SELECT version FROM boards WHERE id=?'),
 bump:db.prepare('UPDATE boards SET version=version+1 WHERE id=?'),
 activity:db.prepare('SELECT a.id,a.action,a.detail,a.created_at,u.name user_name FROM activity_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.board=? ORDER BY a.id DESC LIMIT 100'),
 log:db.prepare('INSERT INTO activity_log(board,user_id,action,detail) VALUES(?,?,?,?)')
};
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const token=()=>crypto.randomBytes(32).toString('base64url');
const validId=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(s);
const validName=s=>typeof s==='string'&&s.trim().length>=1&&s.trim().length<=50;
const validTitle=s=>typeof s==='string'&&s.trim().length>0&&s.length<=200;
const validDesc=s=>typeof s==='string'&&s.length<=2000;
const validPos=n=>Number.isFinite(n)&&Math.abs(n)<1e12;

function cleanOp(op){
 if(!op||typeof op!=='object'||!validId(op.id))return null;
 if(op.type==='card.delete')return{type:op.type,id:op.id};
 if(op.type==='card.update'){
  const title=op.title===undefined?undefined:(validTitle(op.title)?op.title.trim():null);
  const description=op.description===undefined?undefined:(validDesc(op.description)?op.description:null);
  if(title===null||description===null||(title===undefined&&description===undefined))return null;
  return{type:op.type,id:op.id,title,description};
 }
 if(op.type==='card.move')return COLS.includes(op.col)&&validPos(op.pos)?{type:op.type,id:op.id,col:op.col,pos:op.pos}:null;
 if(op.type==='card.create')return COLS.includes(op.col)&&validPos(op.pos)&&validTitle(op.title)?{type:op.type,id:op.id,col:op.col,pos:op.pos,title:op.title.trim(),description:validDesc(op.description)?op.description:''}:null;
 return null;
}
function apply(board,op){
 if(op.type==='card.create')return q.insertCard.run(op.id,board,op.col,op.title,op.description,op.pos).changes>0;
 if(!q.hasCard.get(op.id,board))return false;
 if(op.type==='card.update')return q.updateCard.run(op.title??null,op.description??null,op.id,board).changes>0;
 if(op.type==='card.move')return q.moveCard.run(op.col,op.pos,op.id,board).changes>0;
 return q.deleteCard.run(op.id,board).changes>0;
}
const commit=db.transaction((board,op)=>{if(!apply(board,op))return null;q.bump.run(board);return q.version.get(board).version});
function logActivity(board,userId,action,detail){try{q.log.run(board,userId,action,JSON.stringify(detail).slice(0,1000))}catch{}}
const rooms=new Map();
function room(board){let r=rooms.get(board);if(!r){r={clients:new Set(),seen:new Map()};rooms.set(board,r)}return r}
const send=(ws,m)=>ws.readyState===1&&ws.send(JSON.stringify(m));
const broadcast=(r,m,except)=>r.clients.forEach(c=>c!==except&&send(c,m));
function originAllowed(req){return !ALLOWED_ORIGIN||req.headers.origin===ALLOWED_ORIGIN}
function sendJson(res,code,obj,req){const origin=ALLOWED_ORIGIN&&req.headers.origin===ALLOWED_ORIGIN?ALLOWED_ORIGIN:'null';res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':origin,'access-control-allow-headers':'content-type,x-auth-token'});res.end(JSON.stringify(obj))}
async function readBody(req){let size=0,body='';for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY)throw new Error('payload too large');body+=chunk}return body?JSON.parse(body):{}}
function auth(req,res){const raw=req.headers['x-auth-token'];const user=typeof raw==='string'&&raw.length<=256?q.userByToken.get(hash(raw)):null;if(!user){sendJson(res,401,{error:'authentication required'},req);return null}return user}

const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(req.method==='OPTIONS'){sendJson(res,204,{},req);return}
 if(!originAllowed(req)){sendJson(res,403,{error:'origin rejected'},req);return}
 if(url.pathname==='/healthz'){sendJson(res,200,{ok:true,version:1},req);return}
 if(url.pathname==='/api/auth'&&req.method==='POST'){
  try{const body=await readBody(req);if(!validName(body.name))return sendJson(res,400,{error:'name must be 1-50 characters'},req);const id=crypto.randomUUID(),rawToken=token();q.insertUser.run(id,body.name.trim(),hash(rawToken));return sendJson(res,201,{user:{id,name:body.name.trim()},token:rawToken},req)}
  catch{return sendJson(res,400,{error:'invalid request'},req)}
 }
 const user=auth(req,res);if(!user)return;
 if(url.pathname==='/api/boards'&&req.method==='GET')return sendJson(res,200,q.listBoards.all(user.id).map(b=>({...b,user_role:b.role})),req);
 if(url.pathname==='/api/boards'&&req.method==='POST'){
  try{const body=await readBody(req);const name=validName(body.name)?body.name.trim():'Untitled board';const id=crypto.randomBytes(9).toString('base64url');const shareToken=token();db.transaction(()=>{q.insertBoard.run(id,name,hash(shareToken),user.id);q.addMember.run(id,user.id,'owner');logActivity(id,user.id,'board.create',{name})})();return sendJson(res,201,{board:{id,name,role:'owner'},shareToken},req)}
  catch{return sendJson(res,400,{error:'failed to create board'},req)}
 }
 const match=url.pathname.match(/^\/api\/boards\/([^/]+)(?:\/(activity|join))?$/);
 if(match){
  const boardId=match[1],action=match[2];
  if(!validId(boardId))return sendJson(res,400,{error:'invalid board id'},req);
  if(action==='join'&&req.method==='POST'){
   const share=url.searchParams.get('key');const b=typeof share==='string'?q.boardByShare.get(hash(share)):null;
   if(!b||b.id!==boardId)return sendJson(res,403,{error:'invalid board share link'},req);
   q.addMember.run(boardId,user.id,'editor');logActivity(boardId,user.id,'board.join',{});return sendJson(res,200,{board:{id:b.id,name:b.name,role:'editor'}},req);
  }
  const membership=q.member.get(boardId,user.id);if(!membership)return sendJson(res,403,{error:'not a board member'},req);
  if(action==='activity'&&req.method==='GET')return sendJson(res,200,q.activity.all(boardId),req);
  if(!action&&req.method==='DELETE'){
   if(membership.role!=='owner')return sendJson(res,403,{error:'owner access required'},req);
   db.transaction(()=>q.deleteBoard.run(boardId))();rooms.delete(boardId);return sendJson(res,200,{success:true},req);
  }
 }
 const publicDir=path.join(dir,'public');const file=path.join(publicDir,path.normalize(url.pathname==='/'?'/index.html':url.pathname));
 if(!file.startsWith(publicDir+path.sep)&&file!==publicDir)return sendJson(res,403,{error:'forbidden'},req);
 fs.readFile(file,(err,buf)=>{if(err){res.writeHead(404);return res.end('Not found')}const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon'};res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream','x-content-type-options':'nosniff','referrer-policy':'same-origin','cache-control':'no-cache'});res.end(buf)})
});

const wss=new WebSocketServer({server,path:'/ws',maxPayload:16*1024});
wss.on('connection',(ws,req)=>{
 if(!originAllowed(req))return ws.close(1008,'origin');
 const p=new URL(req.url,'http://localhost').searchParams,boardId=p.get('board')||'',rawToken=p.get('token')||'',user=rawToken?q.userByToken.get(hash(rawToken)):null;
 if(!user||!validId(boardId)||!q.member.get(boardId,user.id))return ws.close(1008,'unauthorized');
 ws.board=boardId;ws.user={id:user.id,name:user.name,color:COLORS[parseInt(user.id.replace(/\D/g,'').slice(0,6)||'0',10)%COLORS.length]};ws.alive=true;ws.hits=0;
 const r=room(boardId),presence=()=>[...r.clients].map(c=>c.user);r.clients.add(ws);
 send(ws,{t:'snapshot',v:q.version.get(boardId).version,cards:q.cards.all(boardId),you:ws.user.id,users:presence()});broadcast(r,{t:'presence',users:presence()},ws);
 ws.on('pong',()=>ws.alive=true);
 ws.on('message',raw=>{
  if(++ws.hits>60)return ws.close(1008,'rate limit');
  let msg;try{msg=JSON.parse(raw)}catch{return ws.close(1003,'invalid json')}
  if(msg?.t!=='op'||typeof msg.opId!=='string'||msg.opId.length>64)return;
  if(r.seen.has(msg.opId))return send(ws,{t:'ack',opId:msg.opId,v:r.seen.get(msg.opId)});
  const op=cleanOp(msg.op);if(!op)return send(ws,{t:'nack',opId:msg.opId,error:'invalid operation'});
  const nv=commit(boardId,op),v=nv===null?q.version.get(boardId).version:nv;
  if(nv!==null){broadcast(r,{t:'op',op,v,by:user.id},ws);logActivity(boardId,user.id,op.type,{op})}
  r.seen.set(msg.opId,v);if(r.seen.size>5000)r.seen.delete(r.seen.keys().next().value);send(ws,{t:'ack',opId:msg.opId,v});
 });
 ws.on('close',()=>{r.clients.delete(ws);broadcast(r,{t:'presence',users:presence()});if(!r.clients.size)rooms.delete(boardId)})
});
setInterval(()=>wss.clients.forEach(c=>c.hits=0),1000).unref();
setInterval(()=>wss.clients.forEach(c=>{if(!c.alive)return c.terminate();c.alive=false;c.ping()}),30000).unref();
server.listen(PORT,()=>console.log(\`Tackboard listening on :\${server.address().port}\`));
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{wss.clients.forEach(c=>c.close(1001,'restart'));server.close(()=>{db.close();process.exit(0)});setTimeout(()=>process.exit(0),3000).unref()});
