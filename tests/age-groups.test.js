import { it, expect, afterEach } from 'vitest';
import { io } from 'socket.io-client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQuizServer } from '../server/app.js';
const servers=[], sockets=[];
afterEach(async()=>{sockets.splice(0).forEach(s=>s.close());for(const s of servers.splice(0)) await s.close();});
const call=(s,event,p={})=>new Promise(resolve=>s.emit(event,p,resolve));
async function connect(srv,auth={}){const s=io(`http://127.0.0.1:${srv.port}`,{transports:['websocket'],auth,forceNew:true,reconnection:false});sockets.push(s);s.on('state',st=>{s.lastPublicState=st;});await new Promise((resolve,reject)=>{s.on('connect',resolve);s.on('connect_error',reject);});return s;}
async function setup(file){file ??=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'qa-ages-')),'state.json');const srv=createQuizServer({readSec:0,host:'127.0.0.1',port:0,staticDir:null,adminPassword:'test-ages',dataFile:file});servers.push(srv);await srv.start();const admin=await connect(srv,{role:'admin'});const login=await call(admin,'a:login',{password:'test-ages'});return {srv,admin,file,token:login.token};}
async function tournament(admin){expect((await call(admin,'a:tournament:create',{name:'Один кубок',ageMode:true,teamNames:'Младшие 1 | junior\nМладшие 2 | junior\nСредние | middle\nСтаршие | senior',questions:'Младший вопрос | да | | 2\nМладший второй | нет',answerSec:0,quizSec:0})).ok).toBe(true);}
async function state(admin){return (await call(admin,'a:state')).state;}
async function captain(srv,team){const sock=await connect(srv);expect((await call(sock,'team:login',{team:team.id,pin:team.pin})).ok).toBe(true);return sock;}

it('один турнир: независимые вопросы и места, ответы только активного возраста, PIN и подключения сохраняются',async()=>{
 const {srv,admin}=await setup();await tournament(admin);const initial=await state(admin);const id=initial.activeId;const pins=initial.teams.map(t=>t.pin);
 const junior=await captain(srv,initial.teams[0]), middle=await captain(srv,initial.teams[2]);
 const q=(await call(admin,'a:quiz:open')).quizId;
 expect((await call(middle,'team:answer',{quizId:q,text:'да'})).reason).toBe('inactive_age');
 expect((await call(junior,'team:answer',{quizId:q,text:'да'})).ok).toBe(true);
 expect((await call(admin,'a:age:activate',{age:'middle'})).ok).toBe(false);
 expect((await call(admin,'a:questions:set',{text:'затирание'})).ok).toBe(false);
 await call(admin,'a:quiz:close');await call(admin,'a:quiz:reset');
 expect((await state(admin)).pub.tournament.question).toBe(2);
 await call(admin,'a:age:activate',{age:'middle'});expect((await state(admin)).questions).toHaveLength(0);
 await call(admin,'a:questions:set',{text:'Средний вопрос | другой | | 3'});
 const mq=(await call(admin,'a:quiz:open')).quizId;await call(middle,'team:answer',{quizId:mq,text:'другой'});await call(admin,'a:quiz:close');await call(admin,'a:quiz:reset');
 await call(admin,'a:age:results',{age:'middle'});const after=await state(admin);expect(after.activeId).toBe(id);expect(after.teams.map(t=>t.pin)).toEqual(pins);expect(junior.connected&&middle.connected).toBe(true);
 expect(after.pub.board).toHaveLength(1);expect(after.pub.board[0]).toMatchObject({age:'middle',score:3,rank:1});expect(after.pub.boards.junior[0]).toMatchObject({score:2,rank:1});expect(after.pub.boards.senior[0]).toMatchObject({score:0,rank:1});
 await call(admin,'a:age:activate',{age:'junior'});await call(admin,'a:age:results',{age:'junior'});const restored=await state(admin);expect(restored.questions[0].q).toBe('Младший вопрос');expect(restored.pub.tournament.question).toBe(2);expect(restored.stats).toHaveLength(2);
});

it('раскрытие и проектор показывают выбранный возраст, CSV содержит три самостоятельных топа',async()=>{
 const {srv,admin,token}=await setup();await tournament(admin);
 await call(admin,'a:age:results',{age:'middle'});await call(admin,'a:reveal:start',{mode:'all'});await call(admin,'a:reveal:next');await call(admin,'a:reveal:next');
 const st=await state(admin);expect(st.pub.tournament.age).toBe('junior');expect(st.pub.reveal.total).toBe(1);expect(st.pub.reveal.shown).toBe(1);expect(st.pub.reveal.rows.every(t=>t.age==='middle')).toBe(true);
 await call(admin,'a:display:set',{view:'leaderboard'});const display=await connect(srv,{role:'display'});const visible=display.lastPublicState || await new Promise(resolve=>display.once('state',resolve));expect(visible.board.map(t=>t.age)).toEqual(['middle']);expect(visible.boards).toBeUndefined();
 const csv=await (await fetch(`http://127.0.0.1:${srv.port}/api/export/results.csv`,{headers:{'x-admin-token':token}})).text();expect(csv).toContain('junior');expect(csv).toContain('middle');expect(csv).toContain('senior');expect(csv.split('\r\n').filter(r=>r.startsWith('1,')).length).toBe(4);
});

it('BUZZ: чужая группа отклоняется, баллы вопроса и статистика учитываются, отмена идемпотентна, повтор очищает только выбранный зачёт',async()=>{
 const {srv,admin}=await setup();await tournament(admin);const teams=(await state(admin)).teams;
 const junior=await captain(srv,teams[0]),middle=await captain(srv,teams[2]);
 await call(admin,'a:score:adjust',{id:teams[2].id,delta:7});
 const r=(await call(admin,'a:round:open')).roundId;
 expect((await call(middle,'team:buzz',{roundId:r,nonce:'wrong-age'})).reason).toBe('inactive_age');
 await call(junior,'team:buzz',{roundId:r,nonce:'valid'});await call(admin,'a:round:judge',{correct:true});
 let st=await state(admin);expect(st.pub.boards.junior[0]).toMatchObject({score:2,correct:1});expect(st.stats[0].answered).toBe(1);expect(st.stats[0].perBlock['1'].points).toBe(2);
 await call(admin,'a:round:undo');st=await state(admin);expect(st.stats[0].correct).toBe(0);expect(st.pub.boards.junior[0].score).toBe(0);
 expect((await call(admin,'a:round:undo')).ok).toBe(false);await call(admin,'a:round:judge',{correct:true});await call(admin,'a:round:reset');
 await call(admin,'a:game:restart');st=await state(admin);expect(st.pub.boards.junior.every(t=>t.score===0)).toBe(true);expect(st.pub.boards.middle[0].score).toBe(7);expect(st.pub.boards.junior[0].correct).toBe(0);
});

it('банки вопросов, прогресс и результаты сохраняются после перезапуска и копирования турнира',async()=>{
 const {srv,admin,file}=await setup();await tournament(admin);await call(admin,'a:round:reset',{advance:true});await call(admin,'a:age:activate',{age:'senior'});await call(admin,'a:questions:set',{text:'Старший вопрос | шесть'});const id=(await state(admin)).activeId;
 await srv.close();servers.splice(servers.indexOf(srv),1);
 const next=await setup(file);let st=await state(next.admin);expect(st.activeId).toBe(id);expect(st.questions[0].q).toBe('Старший вопрос');await call(next.admin,'a:age:activate',{age:'junior'});st=await state(next.admin);expect(st.pub.tournament.question).toBe(2);expect(st.questions).toHaveLength(2);
 await call(next.admin,'a:tournament:create',{copyFrom:id,name:'Копия кубка'});st=await state(next.admin);expect(st.pub.tournament.ageMode).toBe(true);expect(st.pub.tournament.question).toBe(1);expect(st.questions[0].q).toBe('Младший вопрос');await call(next.admin,'a:age:activate',{age:'senior'});expect((await state(next.admin)).questions[0].q).toBe('Старший вопрос');
});

async function rotationBanks(admin, counts = [6,6,6]) {
 for (let i=0;i<3;i++) { const age=['junior','middle','senior'][i]; await call(admin,'a:age:activate',{age}); await call(admin,'a:questions:set',{text:Array.from({length:counts[i]},(_,q)=>`${age} ${q+1} | да`).join('\n')}); }
 await call(admin,'a:age:activate',{age:'junior'});
}
it('ручная игра: один вопрос каждой лиге, следующий круг со второго; обе формы сохраняют PIN, счёт и архив',async()=>{
 const {srv,admin}=await setup();await tournament(admin);await rotationBanks(admin);
 const initial=await state(admin),pins=initial.teams.map(t=>t.pin),id=initial.activeId;
 const caps={};for(const age of ['junior','middle','senior'])caps[age]=await captain(srv,initial.teams.find(t=>t.age===age));
 for(const mode of ['quiz','buzz']) {
  for(let n=1;n<=3;n++)for(const age of ['junior','middle','senior']) {
   const q=mode==='quiz'?n:n+3, before=await state(admin);expect(before.pub.tournament).toMatchObject({age,question:q});
   if(mode==='quiz') {const {quizId}=await call(admin,'a:quiz:open');await call(caps[age],'team:answer',{quizId,text:'да'});await call(admin,'a:quiz:close');expect((await state(admin)).pub.tournament.age).toBe(age);await call(admin,'a:quiz:reset');}
   else {const {roundId}=await call(admin,'a:round:open');await call(caps[age],'team:buzz',{roundId,nonce:`${age}-${q}`});await call(admin,'a:round:judge',{correct:true});await call(admin,'a:round:reset');}
  }
 }
 const end=await state(admin);expect(end.ageGroups.every(g=>g.finished)).toBe(true);expect(end.teams.map(t=>t.pin)).toEqual(pins);expect(end.activeId).toBe(id);expect(end.historyCount).toBe(6);
 for(const age of ['junior','middle','senior'])expect(end.pub.boards[age][0]).toMatchObject({score:60,correct:6});
});
it('автоигра обходит шесть кругов и завершает турнир только после последней лиги',async()=>{
 const {admin}=await setup();await tournament(admin);await rotationBanks(admin);await call(admin,'a:settings:update',{quizSec:1,pauseSec:0,resultSec:0,blockBreak:false});
 expect((await call(admin,'a:auto:start',{mode:'quiz'})).ok).toBe(true);
 const seen=[];let end;const deadline=Date.now()+23000;
 do {end=await state(admin);const t=end.pub.tournament;const key=`${t.age}:${t.question}`;if(seen.at(-1)!==key)seen.push(key);if(end.pub.auto.finished)break;await new Promise(r=>setTimeout(r,20));}while(Date.now()<deadline);
 expect(seen.slice(0,18)).toEqual([1,2,3,4,5,6].flatMap(q=>['junior','middle','senior'].map(age=>`${age}:${q}`)));
 expect(end.pub.auto.running).toBe(false);expect(end.pub.auto.finished).toBe(true);expect(end.ageGroups.every(g=>g.finished)).toBe(true);expect(end.pub.displayView).toBe('closing');
},26000);
it('короткие и пустые банки пропускаются, переход сохраняется после перезапуска',async()=>{
 const {admin,srv,file}=await setup();await tournament(admin);await rotationBanks(admin,[4,1,0]);
 await call(admin,'a:quiz:open');await call(admin,'a:quiz:close');await call(admin,'a:quiz:reset');
 expect((await state(admin)).pub.tournament).toMatchObject({age:'middle',question:1});
 await srv.close();servers.splice(servers.indexOf(srv),1);const reopened=await setup(file);
 await call(reopened.admin,'a:quiz:open');await call(reopened.admin,'a:quiz:close');await call(reopened.admin,'a:quiz:reset');expect((await state(reopened.admin)).pub.tournament).toMatchObject({age:'junior',question:2});
 for(let n=0;n<2;n++){await call(reopened.admin,'a:quiz:open');await call(reopened.admin,'a:quiz:close');await call(reopened.admin,'a:quiz:reset');}
 await call(reopened.admin,'a:quiz:open');await call(reopened.admin,'a:quiz:close');await call(reopened.admin,'a:quiz:reset');expect((await state(reopened.admin)).ageGroups.filter(g=>g.questions>0).every(g=>g.finished)).toBe(true);
});

it('уровни задают время обоих форматов, своё время вопроса важнее, повторное открытие сохраняет уровень',async()=>{
 const {admin}=await setup();await tournament(admin);
 await call(admin,'a:questions:set',{text:'Лёгкий | да | лёгкий\nСредний | да | средний\nСложный | да | сложный\nОсобый | да | сложный | | 7\nБез уровня | да'});
 expect((await call(admin,'a:settings:update',{difficultyTiming:true,difficultySec:{easy:20,medium:30,hard:45},quizSec:17,openSec:13})).ok).toBe(true);
 for(let i=0;i<5;i++){
  const expectedQuiz=[20,30,45,7,17][i], expectedBuzz=[20,30,45,7,13][i];
  await call(admin,'a:settings:update',{question:i+1});await call(admin,'a:quiz:open');expect((await state(admin)).pub.timer.durationMs).toBe(expectedQuiz*1000);
  await call(admin,'a:quiz:close');await call(admin,'a:quiz:open');expect((await state(admin)).pub.timer.durationMs).toBe(expectedQuiz*1000);
  await call(admin,'a:quiz:close');await call(admin,'a:quiz:reset');
  await call(admin,'a:settings:update',{question:i+1});await call(admin,'a:round:open');expect((await state(admin)).pub.timer.durationMs).toBe(expectedBuzz*1000);await call(admin,'a:round:lock');await call(admin,'a:round:reset',{advance:false});
 }
 await call(admin,'a:settings:update',{question:1,difficultyTiming:false});await call(admin,'a:quiz:open');expect((await state(admin)).pub.timer.durationMs).toBe(17000);
});

it('пока отвечают джуны, ответы и нажатия мидлов и сеньоров отклоняются без изменения счёта',async()=>{
 const {srv,admin}=await setup();await tournament(admin);const teams=(await state(admin)).teams;
 const middle=await captain(srv,teams.find(t=>t.age==='middle')),senior=await captain(srv,teams.find(t=>t.age==='senior'));
 const q=(await call(admin,'a:quiz:open')).quizId;
 for(const c of [middle,senior])expect((await call(c,'team:answer',{quizId:q,text:'да'})).reason).toBe('inactive_age');
 let st=await state(admin);expect(st.quizAnswers).toHaveLength(0);expect(st.pub.quiz.answeredCount).toBe(0);expect(st.pub.activeTeamCount).toBe(2);
 await call(admin,'a:quiz:close');await call(admin,'a:quiz:reset');const roundId=(await call(admin,'a:round:open')).roundId;
 for(const c of [middle,senior])expect((await call(c,'team:buzz',{roundId,nonce:Math.random().toString()})).reason).toBe('inactive_age');
 st=await state(admin);expect(st.buzzes).toHaveLength(0);expect(st.teams.every(t=>t.score===0)).toBe(true);
});

it('время по сложности проверяется до записи и сохраняется после перезапуска',async()=>{
 const {admin,srv,file}=await setup();await tournament(admin);await call(admin,'a:settings:update',{difficultyTiming:true,difficultySec:{easy:15,medium:25,hard:50}});
 expect((await call(admin,'a:settings:update',{difficultySec:{easy:0,medium:4000}})).ok).toBe(false);expect((await state(admin)).settings.difficultySec).toEqual({easy:15,medium:25,hard:50});
 await srv.close();servers.splice(servers.indexOf(srv),1);const reopened=await setup(file);expect((await state(reopened.admin)).settings).toMatchObject({difficultyTiming:true,difficultySec:{easy:15,medium:25,hard:50}});
});

it('общий новый старт очищает все зачёты, сохраняя банки, команды, PIN и подключения',async()=>{
 const {srv,admin}=await setup();await tournament(admin);await rotationBanks(admin,[2,2,2]);
 const initial=await state(admin);const caps={};for(const age of ['junior','middle','senior'])caps[age]=await captain(srv,initial.teams.find(t=>t.age===age));
 for(const age of ['junior','middle','senior']){const {quizId}=await call(admin,'a:quiz:open');await call(caps[age],'team:answer',{quizId,text:'да'});await call(admin,'a:quiz:close');await call(admin,'a:quiz:reset');}
 await call(admin,'a:age:activate',{age:'senior'});const {roundId}=await call(admin,'a:round:open');await call(caps.senior,'team:buzz',{roundId,nonce:'senior-second'});await call(admin,'a:round:judge',{correct:true});
 expect((await call(admin,'a:game:restart',{allAges:true})).ok).toBe(true);const st=await state(admin);
 expect(st.activeId).toBe(initial.activeId);expect(st.teams.map(t=>({id:t.id,pin:t.pin,age:t.age}))).toEqual(initial.teams.map(t=>({id:t.id,pin:t.pin,age:t.age})));
 expect(st.teams.every(t=>t.score===0)).toBe(true);expect(Object.values(caps).every(c=>c.connected)).toBe(true);expect(st.pub.tournament).toMatchObject({age:'junior',question:1,round:1});expect(st.ageGroups.every(g=>g.question===1&&g.questions===2)).toBe(true);expect(st.pub.quiz.status).toBe('idle');expect(st.pub.status).toBe('idle');
 for(const age of ['junior','middle','senior']){expect(st.pub.boards[age].every(t=>t.correct===0)).toBe(true);await call(admin,'a:age:results',{age});expect((await state(admin)).historyCount).toBe(0);}
});
