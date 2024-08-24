import type { ParsedUrlQuery } from 'querystring'
import type {
  AppRenderContext,
  GetDynamicParamFromSegment,
} from '../../server/app-render/app-render'
import type { LoaderTree } from '../../server/lib/app-dir-module'

import React from 'react'
import {
  AppleWebAppMeta,
  FormatDetectionMeta,
  ItunesMeta,
  BasicMeta,
  ViewportMeta,
  VerificationMeta,
  FacebookMeta,
} from './generate/basic'
import { AlternatesMetadata } from './generate/alternate'
import {
  OpenGraphMetadata,
  TwitterMetadata,
  AppLinksMeta,
} from './generate/opengraph'
import { IconsMetadata } from './generate/icons'
import { resolveMetadata } from './resolve-metadata'
import { MetaFilter } from './generate/meta'
import type {
  ResolvedMetadata,
  ResolvedViewport,
} from './types/metadata-interface'
import { isNotFoundError } from '../../client/components/not-found'
import type { MetadataContext } from './types/resolvers'
import type { CreateDynamicallyTrackedParams } from '../../client/components/fallback-params'
import type { StaticGenerationStore } from '../../client/components/static-generation-async-storage.external'
import { trackFallbackParamAccessed } from '../../server/app-render/dynamic-rendering'

export function createMetadataContext(
  pathname: string,
  renderOpts: AppRenderContext['renderOpts']
): MetadataContext {
  return {
    pathname,
    trailingSlash: renderOpts.trailingSlash,
    isStandaloneMode: renderOpts.nextConfigOutput === 'standalone',
  }
}

export function createTrackedMetadataContext(
  pathname: string,
  renderOpts: AppRenderContext['renderOpts'],
  staticGenerationStore: StaticGenerationStore | null
): MetadataContext {
  return {
    // Use the regular metadata context, but we trap the pathname access.
    ...createMetadataContext(pathname, renderOpts),

    // Setup the trap around the pathname access so we can track when the
    // pathname is accessed while resolving metadata which would indicate it's
    // being used to resolve a relative URL. If that's the case, we don't want
    // to provide it, and instead we should error.
    get pathname() {
      if (
        staticGenerationStore &&
        staticGenerationStore.isStaticGeneration &&
        staticGenerationStore.fallbackRouteParams &&
        staticGenerationStore.fallbackRouteParams.size > 0
      ) {
        trackFallbackParamAccessed(staticGenerationStore, 'pathname')
      }

      return pathname
    },
  }
}

// Use a promise to share the status of the metadata resolving,
// returning two components `MetadataTree` and `MetadataOutlet`
// `MetadataTree` is the one that will be rendered at first in the content sequence for metadata tags.
// `MetadataOutlet` is the one that will be rendered under error boundaries for metadata resolving errors.
// In this way we can let the metadata tags always render successfully,
// and the error will be caught by the error boundary and trigger fallbacks.
export function createMetadataComponents({
  tree,
  query,
  metadataContext,
  getDynamicParamFromSegment,
  appUsingSizeAdjustment,
  errorType,
  createDynamicallyTrackedSearchParams,
  createDynamicallyTrackedParams,
}: {
  tree: LoaderTree
  query: ParsedUrlQuery
  metadataContext: MetadataContext
  getDynamicParamFromSegment: GetDynamicParamFromSegment
  appUsingSizeAdjustment: boolean
  errorType?: 'not-found' | 'redirect'
  createDynamicallyTrackedParams: CreateDynamicallyTrackedParams
  createDynamicallyTrackedSearchParams: (
    searchParams: ParsedUrlQuery
  ) => ParsedUrlQuery
}): [React.ComponentType, () => Promise<void>] {
  let currentMetadataReady:
    | null
    | (Promise<void> & {
        status?: string
        value?: unknown
      }) = null

  async function MetadataTree() {
    const pendingMetadata = getResolvedMetadata(
      tree,
      query,
      getDynamicParamFromSegment,
      metadataContext,
      createDynamicallyTrackedSearchParams,
      createDynamicallyTrackedParams,
      errorType
    )

    // We construct this instrumented promise to allow React.use to synchronously unwrap
    // it if it has already settled.
    const metadataReady: Promise<void> & { status: string; value: unknown } =
      pendingMetadata.then(
        ([error]) => {
          if (error) {
            metadataReady.status = 'rejected'
            metadataReady.value = error
            throw error
          }
          metadataReady.status = 'fulfilled'
          metadataReady.value = undefined
        },
        (error) => {
          metadataReady.status = 'rejected'
          metadataReady.value = error
          throw error
        }
      ) as Promise<void> & { status: string; value: unknown }
    metadataReady.status = 'pending'
    currentMetadataReady = metadataReady
    // We aren't going to await this promise immediately but if it rejects early we don't
    // want unhandled rejection errors so we attach a throwaway catch handler.
    metadataReady.catch(() => {})

    // We ignore any error from metadata here because it needs to be thrown from within the Page
    // not where the metadata itself is actually rendered
    const [, elements] = await pendingMetadata

    return (
      <>
        {elements.map((el, index) => {
          return React.cloneElement(el as React.ReactElement, { key: index })
        })}
        {appUsingSizeAdjustment ? <meta name="next-size-adjust" /> : null}
      </>
    )
  }

  function getMetadataReady() {
    return Promise.resolve().then(() => {
      if (currentMetadataReady) {
        return currentMetadataReady
      }
      throw new Error(
        'getMetadataReady was called before MetadataTree rendered'
      )
    })
  }

  return [MetadataTree, getMetadataReady]
}

async function getResolvedMetadata(
  tree: LoaderTree,
  query: ParsedUrlQuery,
  getDynamicParamFromSegment: GetDynamicParamFromSegment,
  metadataContext: MetadataContext,
  createDynamicallyTrackedSearchParams: (
    searchParams: ParsedUrlQuery
  ) => ParsedUrlQuery,
  createDynamicallyTrackedParams: CreateDynamicallyTrackedParams,
  errorType?: 'not-found' | 'redirect'
): Promise<[any, Array<React.ReactNode>]> {
  const errorMetadataItem: [null, null, null] = [null, null, null]
  const errorConvention = errorType === 'redirect' ? undefined : errorType
  const searchParams = createDynamicallyTrackedSearchParams(query)

  const [error, metadata, viewport] = await resolveMetadata({
    tree,
    parentParams: {},
    metadataItems: [],
    errorMetadataItem,
    searchParams,
    getDynamicParamFromSegment,
    errorConvention,
    metadataContext,
    createDynamicallyTrackedParams,
  })
  if (!error) {
    return [null, createMetadataElements(metadata, viewport)]
  } else {
    // If a not-found error is triggered during metadata resolution, we want to capture the metadata
    // for the not-found route instead of whatever triggered the error. For all error types, we resolve an
    // error, which will cause the outlet to throw it so it'll be handled by an error boundary
    // (either an actual error, or an internal error that renders UI such as the NotFoundBoundary).
    if (!errorType && isNotFoundError(error)) {
      const [notFoundMetadataError, notFoundMetadata, notFoundViewport] =
        await resolveMetadata({
          tree,
          parentParams: {},
          metadataItems: [],
          errorMetadataItem,
          searchParams,
          getDynamicParamFromSegment,
          errorConvention: 'not-found',
          metadataContext,
          createDynamicallyTrackedParams,
        })
      return [
        notFoundMetadataError || error,
        createMetadataElements(notFoundMetadata, notFoundViewport),
      ]
    }
    return [error, []]
  }
}

function createMetadataElements(
  metadata: ResolvedMetadata,
  viewport: ResolvedViewport
) {
  return MetaFilter([
    ViewportMeta({ viewport: viewport }),
    BasicMeta({ metadata }),
    AlternatesMetadata({ alternates: metadata.alternates }),
    ItunesMeta({ itunes: metadata.itunes }),
    FacebookMeta({ facebook: metadata.facebook }),
    FormatDetectionMeta({ formatDetection: metadata.formatDetection }),
    VerificationMeta({ verification: metadata.verification }),
    AppleWebAppMeta({ appleWebApp: metadata.appleWebApp }),
    OpenGraphMetadata({ openGraph: metadata.openGraph }),
    TwitterMetadata({ twitter: metadata.twitter }),
    AppLinksMeta({ appLinks: metadata.appLinks }),
    IconsMetadata({ icons: metadata.icons }),
  ])
}
