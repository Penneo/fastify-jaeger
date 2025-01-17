'use strict'

const assert = require('assert')
const fp = require('fastify-plugin')
const { initTracer, initTracerFromEnv, opentracing, ZipkinB3TextMapCodec } = require('jaeger-client')
const { parse } = require('uri-js');
const url = require('url');

const { Tags, FORMAT_HTTP_HEADERS } = opentracing

function jaegerPlugin(fastify, opts, next) {
  const { state = {}, initTracerOpts = {}, useEnvVarsAsConfig = false, ...tracerConfig } = opts
  const exposeAPI = opts.exposeAPI !== false

  const defaultOptions = {
    logger: fastify.log
  }

  let tracer

  if (useEnvVarsAsConfig) {
    tracer = initTracerFromEnv(
      { ...tracerConfig },
      { ...defaultOptions, ...initTracerOpts }
    )
  } else {
    const defaultConfig = {
      sampler: {
        type: 'const',
        param: 1
      },
      reporter: {
        logSpans: false
      }
    }

    tracer = initTracer(
      { ...defaultConfig, ...tracerConfig },
      { ...defaultOptions, ...initTracerOpts }
    )
  }

  const tracerMap = new WeakMap()

  function api() {
    const req = this
    return {
      get span() {
        return tracerMap.get(req)
      },
      tags: Tags
    }
  }

  if (exposeAPI) {
    fastify.decorateRequest('jaeger', api);
  }

  if (tracer.registerInjector && tracer.registerExtractor) {
    let codec = new ZipkinB3TextMapCodec({ urlEncoding: true })

    tracer.registerInjector(FORMAT_HTTP_HEADERS, codec)
    tracer.registerExtractor(FORMAT_HTTP_HEADERS, codec)
  }

  function filterObject(obj) {
    const ret = {}
    Object.keys(obj)
    .filter((key) => obj[key] != null)
    .forEach((key) => {
      ret[key] = obj[key]
    })

    return ret
  }

  function setContext(headers) {
    return filterObject({ ...headers, ...state })
  }

  function onRequest(req, res, done) {
    const parentSpanContext = tracer.extract(FORMAT_HTTP_HEADERS, setContext(req.raw.headers))
    const parsedUri = parse(req.raw.url);
    const span = tracer.startSpan(`${req.raw.method} ${parsedUri.path}`, {
      childOf: parentSpanContext,
      tags: {
        [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_SERVER,
        [Tags.HTTP_METHOD]: req.raw.method,
        [Tags.HTTP_URL]: url.format(req.raw.url)
      }
    })

    tracerMap.set(req, span)
    done()
  }

  function onResponse(req, reply, done) {
    const span = tracerMap.get(req)
    span.setTag(Tags.HTTP_STATUS_CODE, reply.statusCode)
    span.finish()
    done()
  }

  function onError(req, reply, error, done) {
    const span = tracerMap.get(req)
    span.setTag(Tags.ERROR, {
      'error.object': error,
      message: error.message,
      stack: error.stack
    })
    done()
  }

  function onClose(instance, done) {
    // tracer.close function is missing from NoOp tracer used when tracing is disabled
    if (tracer.close) {
      tracer.close(done);
    } else {
      done();
    }
  }

  fastify.addHook('onRequest', onRequest)
  fastify.addHook('onResponse', onResponse)
  fastify.addHook('onError', onError)
  fastify.addHook('onClose', onClose)

  next()
}

module.exports = fp(jaegerPlugin, { name: 'fastify-jaeger' })
