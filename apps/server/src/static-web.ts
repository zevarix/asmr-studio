import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

const contentTypes:Readonly<Record<string,string>> = {
  '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.gif':'image/gif', '.webp':'image/webp', '.avif':'image/avif', '.ico':'image/x-icon',
  '.woff':'font/woff', '.woff2':'font/woff2',
};
interface WebFile { path:string; contentType:string; bytes:Buffer }
export interface BuiltWeb { readonly files:readonly WebFile[] }

/** Read only the built public entry point and assets, before opening private storage.
 * Keeping their bytes here also prevents an on-disk update or symlink swap from
 * changing what an already-running version serves. Source and data paths never
 * participate in request resolution.
 */
export function loadBuiltWeb(directory:string):BuiltWeb {
  try {
    if (!lstatSync(directory).isDirectory()) throw new Error('Invalid build directory');
    const root=realpathSync(directory);
    const files:WebFile[]=[];
    function read(path:string):Buffer {
      const absolute=join(root,path);
      const expected=lstatSync(absolute);
      if (!expected.isFile()) throw new Error('Invalid build file');
      const within=relative(root,realpathSync(absolute));
      if (within==='..' || within.startsWith('..'+sep)) throw new Error('Invalid build path');
      const fd=openSync(absolute,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened=fstatSync(fd);
        if (!opened.isFile() || opened.dev!==expected.dev || opened.ino!==expected.ino) {
          throw new Error('Invalid build file');
        }
        return readFileSync(fd);
      } finally {closeSync(fd);}
    }
    const index=read('index.html');
    files.push({path:'/',contentType:'text/html; charset=utf-8',bytes:index},
      {path:'/index.html',contentType:'text/html; charset=utf-8',bytes:index});
    function assets(path:string):void {
      const absolute=join(root,path);
      if (!lstatSync(absolute).isDirectory()) throw new Error('Invalid assets directory');
      for (const entry of readdirSync(absolute,{withFileTypes:true})) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.name) || entry.isSymbolicLink()) {
          throw new Error('Invalid build asset');
        }
        const child=path+'/'+entry.name;
        if (entry.isDirectory()) { assets(child);continue; }
        if (!entry.isFile()) throw new Error('Invalid build asset');
        const contentType=contentTypes[extname(entry.name)];
        if (contentType) files.push({path:'/'+child,contentType,bytes:read(child)});
      }
    }
    assets('assets');
    // Vite's entry page names its script and stylesheet explicitly. Checking
    // those references catches a partial build even if unrelated assets remain.
    const references=[...index.toString('utf8').matchAll(/\b(?:src|href)=["'](\/assets\/[^"']+)["']/g)]
      .map(match=>match[1]!);
    const paths=new Set(files.map(file=>file.path));
    if (!references.some(path=>extname(path)==='.js') || references.some(path=>!paths.has(path))) {
      throw new Error('Build entry assets are missing');
    }
    return {files};
  } catch {
    throw new Error('The built studio interface is missing or invalid. Run npm run build before npm start.');
  }
}

/** Exact routes deliberately leave unknown API, source and deep-link paths as 404s.
 * Saved sessions use /?scene=..., so no broad SPA fallback is necessary.
 * buildApp's Host/Origin guard, no-store policy and nosniff header also cover these.
 */
export function registerBuiltWeb(app:FastifyInstance,build:BuiltWeb):void {
  for (const file of build.files) {
    app.get(file.path,async (_request,reply)=>reply.type(file.contentType).send(file.bytes));
  }
}
