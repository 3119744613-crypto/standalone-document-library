import test from 'node:test';
import assert from 'node:assert/strict';
import {harness, json, deferred, until, drain} from './ui-harness.mjs';

test('denied preview continuation clears previous content', async()=>{
 let denied=false;
 const app=harness(({path})=>path.includes('/content?') ? (denied ? json({error:{message:'denied'}},403) : json({content:'Previously authorized sample passage',has_more_after:true,next_offset:200,total_lines:201,end_line:200})) : undefined);
 await app.login(); await app.select(0);
 app.el('document-rows').children[0].children[2].children[0].children[0].fire('click');
 await until(()=>app.el('preview-content').textContent.includes('sample'));
 denied=true;app.el('load-more-content').fire('click');await drain();
 assert.equal(app.el('preview-content').textContent,'');
});
test('successful delete invalidates visible query source passages', async()=>{
 let deleted=false;
 const app=harness(({path,options})=>{
  if(path==='/api/databases/a/query')return json({results:[{file_id:'doc-a',content:'Deleted source passage'}]});
  if(options.method==='DELETE'){deleted=true;return json({message:'deleted'});}
  if(deleted&&path.startsWith('/api/databases/a/documents?'))return json({documents:[],canManage:true,total:0});
 });
 await app.login();await app.select(0);
 app.el('query-input').value='question';app.el('query-form').fire('submit');await until(()=>app.el('query-sources').children.length===1);
 app.el('document-rows').children[0].children[2].children[0].children[3].fire('click');await drain();
 assert.equal(deleted,true);assert.equal(app.el('document-rows').children.length,0);
 assert.equal(app.el('query-sources').children.length,0);
});
test('successful deletion invalidates a query already in flight', async()=>{
 const pending=deferred();let deleted=false;
 const app=harness(({path,options})=>{
  if(path==='/api/databases/a/query')return pending.promise;
  if(options.method==='DELETE'){deleted=true;return json({message:'deleted'});}
  if(deleted&&path.startsWith('/api/databases/a/documents?'))return json({documents:[],canManage:true,total:0});
 });
 await app.login();await app.select(0);
 app.el('query-input').value='question';app.el('query-form').fire('submit');await until(()=>app.calls.some(c=>c.path.endsWith('/query')));
 app.el('document-rows').children[0].children[2].children[0].children[3].fire('click');await drain();
 pending.resolve(json({results:[{file_id:'doc-a',content:'Late deleted source passage'}]}));await drain();
 assert.equal(app.el('query-sources').children.length,0);
});
test('logout during library creation must not leave the next account create button locked', async()=>{
 const pending=deferred();
 const app=harness(({path,options})=>path==='/api/databases'&&options.method==='POST'?pending.promise:undefined);
 await app.login();
 app.el('new-library').fire('click');
 app.el('create-name').value='Synthetic notes';app.el('create-type').value='milvus';app.el('create-model').value='synthetic-embedding';
 app.el('create-form').fire('submit');
 await until(()=>app.calls.some(call=>call.path==='/api/databases'&&call.options.method==='POST'));
 app.el('logout').fire('click');await app.login();app.el('new-library').fire('click');
 const locked=app.el('create-submit').disabled;
 pending.resolve(json({database:{kb_id:'old-created'}}));await drain();
 assert.equal(locked,false);
 assert.equal(app.el('create-submit').disabled,false);
});
