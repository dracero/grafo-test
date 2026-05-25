import * as dotenv from 'dotenv';
dotenv.config();

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

// Optional: Enable diagnostic logging if OTEL_LOG_LEVEL is set to debug
if (process.env.OTEL_LOG_LEVEL === 'debug') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

const traceExporter = new OTLPTraceExporter();

const sdk = new NodeSDK({
  traceExporter,
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();

console.log('[OpenTelemetry] Native instrumentation initialized and exporting to:', process.env.OTEL_EXPORTER_OTLP_ENDPOINT);

process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('[OpenTelemetry] Tracing terminated gracefully'))
    .catch((error) => console.error('[OpenTelemetry] Error terminating tracing', error))
    .finally(() => process.exit(0));
});
