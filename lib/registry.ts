import type { Namespace, Route } from '@/types';
import { directoryImport } from 'directory-import';
import { Hono, type Handler } from 'hono';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'node:fs';

import { serveStatic } from '@hono/node-server/serve-static';
import { config } from '@/config';

import index from '@/routes/index';
import healthz from '@/routes/healthz';
import robotstxt from '@/routes/robots.txt';
import metrics from '@/routes/metrics';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let modules: Record<string, { route: Route } | { namespace: Namespace }> = {};
let namespaces: Record<
    string,
    Namespace & {
        routes: Record<
            string,
            Route & {
                location: string;
            }
        >;
    }
> = {};

async function loadNamespaces() {
     switch (process.env.NODE_ENV) {
         case 'test':
         case 'production':
             try {
                 const routesPath = path.join(process.cwd(), 'assets', 'build', 'routes.json');
                 if (fs.existsSync(routesPath)) {
                     const routesContent = await fs.promises.readFile(routesPath, 'utf-8');
                     namespaces = JSON.parse(routesContent);
                 } else {
                     console.warn('routes.json not found. Falling back to directory import.');
                     await loadModules();
                 }
             } catch (error) {
                 console.error('Error loading routes.json:', error);
                 await loadModules();
             }
             break;
        default:
             await loadModules();
    }
}

 async function loadModules() {
     modules = directoryImport({
         targetDirectoryPath: path.join(__dirname, './routes'),
         importPattern: /\.ts$/,
     }) as typeof modules;
 
    for (const module in modules) {
        const content = modules[module] as
            | {
                  route: Route;
              }
            | {
                  namespace: Namespace;
              };
        const namespace = module.split(/[/\\]/)[1];
        if ('namespace' in content) {
            namespaces[namespace] = Object.assign(
                {
                    routes: {},
                },
                namespaces[namespace],
                content.namespace
            );
        } else if ('route' in content) {
            if (!namespaces[namespace]) {
                namespaces[namespace] = {
                    name: namespace,
                    routes: {},
                };
            }
            if (Array.isArray(content.route.path)) {
                for (const path of content.route.path) {
                    namespaces[namespace].routes[path] = {
                        ...content.route,
                        location: module.split(/[/\\]/).slice(2).join('/'),
                    };
                }
            } else {
                namespaces[namespace].routes[content.route.path] = {
                    ...content.route,
                    location: module.split(/[/\\]/).slice(2).join('/'),
                };
            }
        }
    }
}

await loadNamespaces();

export { namespaces };

const app = new Hono();
for (const namespace in namespaces) {
    const subApp = app.basePath(`/${namespace}`);
    for (const path in namespaces[namespace].routes) {
        const wrappedHandler: Handler = async (ctx) => {
            if (!ctx.get('data')) {
                if (typeof namespaces[namespace].routes[path].handler !== 'function') {
                    const { route } = await import(`./routes/${namespace}/${namespaces[namespace].routes[path].location}`);
                    namespaces[namespace].routes[path].handler = route.handler;
                }
                ctx.set('data', await namespaces[namespace].routes[path].handler(ctx));
            }
        };
        subApp.get(path, wrappedHandler);
    }
}

app.get('/', index);
app.get('/healthz', healthz);
app.get('/robots.txt', robotstxt);
if (config.debugInfo) {
    // Only enable tracing in debug mode
    app.get('/metrics', metrics);
}
app.use(
    '/*',
    serveStatic({
        root: './lib/assets',
        rewriteRequestPath: (path) => (path === '/favicon.ico' ? '/favicon.png' : path),
    })
);

export default app;
