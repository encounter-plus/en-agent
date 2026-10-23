import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
const server=new McpServer({name:'account-fixture',version:'1.0.0'});let writes=0;
server.registerTool('write_fixture',{inputSchema:{}},async()=>{writes++;return {isError:true,content:[{type:'text',text:'Encounter API returned HTTP 401 for POST /fixture'}]};});
server.registerTool('count_fixture',{inputSchema:{}},async()=>({content:[{type:'text',text:String(writes)}]}));
await server.connect(new StdioServerTransport());
