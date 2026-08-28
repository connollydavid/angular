/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {ApplicationRef, InjectionToken, PlatformRef, Provider, Renderer2, StaticProvider, Type, ɵannotateForHydration as annotateForHydration, ɵIS_HYDRATION_DOM_REUSE_ENABLED as IS_HYDRATION_DOM_REUSE_ENABLED, ɵSSR_CONTENT_INTEGRITY_MARKER as SSR_CONTENT_INTEGRITY_MARKER, ɵwhenStable as whenStable} from '@angular/core';

import {PlatformState} from './platform_state';
import {platformServer} from './server';
import {BEFORE_APP_SERIALIZED, INITIAL_CONFIG} from './tokens';

interface PlatformOptions {
  document?: string|Document;
  url?: string;
  platformProviders?: Provider[];
}

/**
 * Creates an instance of a server platform (with or without JIT compiler support
 * depending on the `ngJitMode` global const value), using provided options.
 */
function createServerPlatform(options: PlatformOptions): PlatformRef {
  const extraProviders = options.platformProviders ?? [];
  return platformServer([
    {provide: INITIAL_CONFIG, useValue: {document: options.document, url: options.url}},
    extraProviders
  ]);
}

/**
 * Serializes server renders at the platform level. The server platform mutates
 * process-global state (the platform injector registry), so overlapping renders
 * could share or overwrite that state across requests. Each render here gets a
 * dedicated platform that is destroyed when the render completes, and renders
 * are chained so only one platform lifecycle is in flight at a time.
 */
let serverPlatformQueue: Promise<unknown> = Promise.resolve();

function runWithDedicatedServerPlatform(
    createPlatform: () => PlatformRef,
    run: (platformRef: PlatformRef) => Promise<string>): Promise<string> {
  const renderPromise = serverPlatformQueue.then(async () => {
    const platformRef = createPlatform();
    try {
      return await run(platformRef);
    } finally {
      // Destroy after a tick so the rendered application's pending async
      // tasks settle before the platform goes away, and never destroy
      // twice (spec teardowns may already have destroyed the platform).
      setTimeout(() => {
        if (!platformRef.destroyed) platformRef.destroy();
      }, 0);
    }
  });
  // Keep the queue alive when a render fails; the failure itself still
  // propagates to the caller.
  serverPlatformQueue = renderPromise.catch(() => undefined);
  return renderPromise;
}

/**
 * Creates a marker comment node and append it into the `<body>`.
 * Some CDNs have mechanisms to remove all comment node from HTML.
 * This behaviour breaks hydration, so we'll detect on the client side if this
 * marker comment is still available or else throw an error
 */
function appendSsrContentIntegrityMarker(doc: Document) {
  // Adding a ng hydration marken comment
  const comment = doc.createComment(SSR_CONTENT_INTEGRITY_MARKER);
  doc.body.firstChild ? doc.body.insertBefore(comment, doc.body.firstChild) :
                        doc.body.append(comment);
}

/**
 * Adds the `ng-server-context` attribute to host elements of all bootstrapped components
 * within a given application.
 */
function appendServerContextInfo(applicationRef: ApplicationRef) {
  const injector = applicationRef.injector;
  let serverContext = sanitizeServerContext(injector.get(SERVER_CONTEXT, DEFAULT_SERVER_CONTEXT));
  applicationRef.components.forEach(componentRef => {
    const renderer = componentRef.injector.get(Renderer2);
    const element = componentRef.location.nativeElement;
    if (element) {
      renderer.setAttribute(element, 'ng-server-context', serverContext);
    }
  });
}

async function _render(platformRef: PlatformRef, applicationRef: ApplicationRef): Promise<string> {
  const environmentInjector = applicationRef.injector;

  // Block until application is stable.
  await whenStable(applicationRef);

  const platformState = platformRef.injector.get(PlatformState);
  if (applicationRef.injector.get(IS_HYDRATION_DOM_REUSE_ENABLED, false)) {
    const doc = platformState.getDocument();
    appendSsrContentIntegrityMarker(doc);
    annotateForHydration(applicationRef, doc);
  }

  // Run any BEFORE_APP_SERIALIZED callbacks just before rendering to string.
  const callbacks = environmentInjector.get(BEFORE_APP_SERIALIZED, null);
  if (callbacks) {
    const asyncCallbacks: Promise<void>[] = [];
    for (const callback of callbacks) {
      try {
        const callbackResult = callback();
        if (callbackResult) {
          asyncCallbacks.push(callbackResult);
        }
      } catch (e) {
        // Ignore exceptions.
        console.warn('Ignoring BEFORE_APP_SERIALIZED Exception: ', e);
      }
    }

    if (asyncCallbacks.length) {
      for (const result of await Promise.allSettled(asyncCallbacks)) {
        if (result.status === 'rejected') {
          console.warn('Ignoring BEFORE_APP_SERIALIZED Exception: ', result.reason);
        }
      }
    }
  }

  appendServerContextInfo(applicationRef);
  const output = platformState.renderToString();

  // Destroy the application in a macrotask, this allows pending promises to be settled and errors
  // to be surfaced to the users.
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      platformRef.destroy();
      resolve();
    }, 0);
  });

  return output;
}

/**
 * Specifies the value that should be used if no server context value has been provided.
 */
const DEFAULT_SERVER_CONTEXT = 'other';

/**
 * An internal token that allows providing extra information about the server context
 * (e.g. whether SSR or SSG was used). The value is a string and characters other
 * than [a-zA-Z0-9\-] are removed. See the default value in `DEFAULT_SERVER_CONTEXT` const.
 */
export const SERVER_CONTEXT = new InjectionToken<string>('SERVER_CONTEXT');

/**
 * Sanitizes provided server context:
 * - removes all characters other than a-z, A-Z, 0-9 and `-`
 * - returns `other` if nothing is provided or the string is empty after sanitization
 */
function sanitizeServerContext(serverContext: string): string {
  const context = serverContext.replace(/[^a-zA-Z0-9\-]/g, '');
  return context.length > 0 ? context : DEFAULT_SERVER_CONTEXT;
}

/**
 * Bootstraps an application using provided NgModule and serializes the page content to string.
 *
 * @param moduleType A reference to an NgModule that should be used for bootstrap.
 * @param options Additional configuration for the render operation:
 *  - `document` - the document of the page to render, either as an HTML string or
 *                 as a reference to the `document` instance.
 *  - `url` - the URL for the current render request.
 *  - `extraProviders` - set of platform level providers for the current render request.
 *
 * @publicApi
 */
export async function renderModule<T>(moduleType: Type<T>, options: {
  document?: string|Document,
  url?: string,
  extraProviders?: StaticProvider[],
}): Promise<string> {
  const {document, url, extraProviders: platformProviders} = options;
  return runWithDedicatedServerPlatform(
      () => createServerPlatform({document, url, platformProviders}),
      async (platformRef) => {
        const moduleRef = await platformRef.bootstrapModule(moduleType);
        const applicationRef = moduleRef.injector.get(ApplicationRef);
        return _render(platformRef, applicationRef);
      });
}

/**
 * Bootstraps an instance of an Angular application and renders it to a string.

 * ```typescript
 * const bootstrap = () => bootstrapApplication(RootComponent, appConfig);
 * const output: string = await renderApplication(bootstrap);
 * ```
 *
 * @param bootstrap A method that when invoked returns a promise that returns an `ApplicationRef`
 *     instance once resolved.
 * @param options Additional configuration for the render operation:
 *  - `document` - the document of the page to render, either as an HTML string or
 *                 as a reference to the `document` instance.
 *  - `url` - the URL for the current render request.
 *  - `platformProviders` - the platform level providers for the current render request.
 *
 * @returns A Promise, that returns serialized (to a string) rendered page, once resolved.
 *
 * @publicApi
 */
export async function renderApplication<T>(bootstrap: () => Promise<ApplicationRef>, options: {
  document?: string|Document,
  url?: string,
  platformProviders?: Provider[],
}): Promise<string> {
  return runWithDedicatedServerPlatform(
      () => createServerPlatform(options),
      async (platformRef) => {
        const applicationRef = await bootstrap();
        return _render(platformRef, applicationRef);
      });
}
