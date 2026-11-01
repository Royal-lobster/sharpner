// THROWAWAY local preview origin. It serves no files or private design data.
// Run under devcap: node worker/overview-origin.prototype.mjs
import {createServer} from "node:http";

const html=`<!doctype html><meta charset="utf-8"><script>
addEventListener("message",function receive(event){
  if(event.source!==parent||event.data?.type!=="overview-bootstrap"||event.data.token!==location.hash.slice(1)||typeof event.data.html!=="string")return;
  removeEventListener("message",receive);document.open();document.write(event.data.html);document.close();
});
parent.postMessage({type:"overview-bootstrap-ready",token:location.hash.slice(1)},"*");
</script>`;
const server=createServer((request,response)=>{
  if(new URL(request.url,"http://localhost").pathname!=="/api/overview-bootstrap"){
    response.writeHead(404);response.end();return;
  }
  response.writeHead(200,{"content-type":"text/html","content-length":Buffer.byteLength(html),"cache-control":"no-store","origin-agent-cluster":"?1"});
  response.end(html);
});
server.listen(5201,"127.0.0.1",()=>process.stdout.write("Prototype preview origin: http://localhost:5201\n"));
for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>server.close(()=>process.exit(0)));
