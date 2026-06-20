require('dotenv').config();
console.log('OTEL_EXPORTER_OTLP_HEADERS:', JSON.stringify(process.env.OTEL_EXPORTER_OTLP_HEADERS));
