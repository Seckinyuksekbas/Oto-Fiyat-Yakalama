import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

export interface RouteInfo {
  method: string;
  path: string;
  /** Reflect metadata hedefi olarak kullanılır */
  handler: object;
  controller: object;
}

const clean = (p: string | undefined) => (p ?? '').replace(/^\/+|\/+$/g, '');

export function listRoutes(app: NestExpressApplication): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const mod of app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const controller = wrapper.metatype as unknown as { prototype: Record<string, unknown> } | null;
      if (!controller?.prototype) continue;
      const base = clean(Reflect.getMetadata(PATH_METADATA, controller));
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = controller.prototype[name];
        if (typeof handler !== 'function' || name === 'constructor') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        const sub = clean(Reflect.getMetadata(PATH_METADATA, handler));
        routes.push({
          method: RequestMethod[method],
          path: '/' + [base, sub].filter(Boolean).join('/'),
          handler,
          controller,
        });
      }
    }
  }
  return routes;
}
