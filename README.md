# PDF Knowledge Graph

Sistema de procesamiento de documentos PDF que construye un grafo de conocimiento en Neo4j utilizando Google Genkit como framework de IA.

## Características

- 📄 Extracción automática de texto de documentos PDF
- 🤖 Análisis inteligente con Google Genkit para identificar entidades y relaciones
- 🔍 Búsqueda vectorial semántica en Neo4j
- 📊 Visualización interactiva del grafo de conocimiento
- ⚙️ Configuración segura mediante variables de entorno

## Requisitos Previos

- Node.js 18 o superior
- Neo4j 5.x o superior (con soporte para índices vectoriales)
- Google API Key para Genkit

## Instalación

1. Clonar el repositorio
2. Instalar dependencias:
   ```bash
   npm install
   ```

3. Copiar el archivo de configuración de ejemplo:
   ```bash
   cp .env.example .env
   ```

4. Editar `.env` con tus credenciales:
   - `NEO4J_URI`: URI de tu instancia de Neo4j
   - `NEO4J_USERNAME`: Usuario de Neo4j
   - `NEO4J_PASSWORD`: Contraseña de Neo4j
   - `GOOGLE_API_KEY`: Tu API key de Google
   - `PDF_FOLDER_PATH`: Ruta a la carpeta con PDFs

## Estructura del Proyecto

```
.
├── src/
│   ├── config/          # Gestión de configuración
│   ├── processors/      # Procesamiento de PDFs
│   ├── services/        # Servicios (Genkit, Neo4j, Visualización)
│   └── models/          # Modelos de datos
├── tests/               # Tests unitarios y property-based
├── dist/                # Código compilado
└── pdfs/                # Carpeta de PDFs a procesar
```

## Scripts Disponibles

- `npm run build` - Compilar TypeScript a JavaScript
- `npm start` - Ejecutar la aplicación compilada
- `npm run dev` - Ejecutar en modo desarrollo
- `npm test` - Ejecutar todos los tests
- `npm run test:watch` - Ejecutar tests en modo watch
- `npm run test:coverage` - Ejecutar tests con reporte de cobertura
- `npm run test:pbt` - Ejecutar solo property-based tests
- `npm run lint` - Verificar tipos con TypeScript

## Uso

1. Colocar archivos PDF en la carpeta especificada en `PDF_FOLDER_PATH`
2. Ejecutar la aplicación:
   ```bash
   npm run dev
   ```
3. Los PDFs serán procesados automáticamente y el grafo se construirá en Neo4j

## Testing

El proyecto utiliza un enfoque dual de testing:

- **Unit Tests**: Para casos específicos y edge cases
- **Property-Based Tests**: Para propiedades universales usando fast-check

Ejecutar tests:
```bash
npm test
```

## Licencia

ISC
