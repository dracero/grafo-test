# Implementation Plan: PDF Knowledge Graph System

## Overview

Este plan de implementación desglosa el sistema de procesamiento de PDFs con grafo de conocimiento en Neo4j en tareas incrementales y ejecutables. El sistema utiliza Google Genkit para análisis de IA, Neo4j para almacenamiento del grafo con búsqueda vectorial, y TypeScript como lenguaje de implementación.

La implementación sigue un enfoque incremental donde cada tarea construye sobre las anteriores, validando funcionalidad core tempranamente mediante código y tests automatizados.

## Tasks

- [-] 1. Configurar estructura del proyecto y dependencias
  - Inicializar proyecto Node.js/TypeScript con configuración de tsconfig
  - Instalar dependencias: `@genkit-ai/core`, `@genkit-ai/googleai`, `neo4j-driver`, `pdf-parse`, `dotenv`, `fast-check`, `jest`
  - Crear estructura de directorios: `src/`, `src/config/`, `src/processors/`, `src/services/`, `src/models/`, `tests/`
  - Configurar Jest para TypeScript con soporte para property-based testing
  - Crear archivo `.env.example` con todas las variables requeridas documentadas
  - _Requirements: 3.1, 3.2, 3.3_

- [ ] 2. Implementar Configuration Manager
  - [-] 2.1 Crear interfaces y tipos de configuración
    - Definir interfaces: `SystemConfig`, `Neo4jConfig`, `GoogleConfig`, `ValidationResult`
    - Implementar enums y tipos auxiliares
    - _Requirements: 3.1, 3.2, 3.3_

  - [-] 2.2 Implementar carga y validación de configuración
    - Implementar método `load()` usando dotenv
    - Implementar método `validate()` con verificación de campos requeridos
    - Implementar getters para cada sección de configuración
    - Manejar errores de archivo .env faltante o credenciales ausentes
    - _Requirements: 3.1, 3.2, 3.4, 3.5, 3.6_

  - [-] 2.3 Implementar serialización de configuración
    - Implementar método `serialize()` que convierte objeto a formato .env
    - Asegurar formato correcto de pares clave-valor
    - _Requirements: 10.3_

  - [ ]* 2.4 Escribir property test para round-trip de serialización
    - **Property 31: Round-trip de serialización de configuración**
    - **Validates: Requirements 10.4**
    - Generar configuraciones válidas aleatorias
    - Verificar que serialize → parse produce objeto equivalente

  - [ ]* 2.5 Escribir property test para detección de credenciales faltantes
    - **Property 4: Detección de credenciales faltantes**
    - **Validates: Requirements 3.5**
    - Generar subconjuntos aleatorios de credenciales
    - Verificar que validate() reporta exactamente las credenciales faltantes

  - [ ]* 2.6 Escribir unit tests para Configuration Manager
    - Test de carga exitosa con .env válido
    - Test de error cuando .env no existe
    - Test de validación con credenciales completas e incompletas
    - Test de logging de advertencias para credenciales opcionales

- [~] 3. Checkpoint - Verificar configuración
  - Ensure all tests pass, ask the user if questions arise.


- [ ] 4. Implementar PDF Processor
  - [-] 4.1 Crear interfaces y tipos para procesamiento de PDFs
    - Definir interfaces: `PDFProcessor`, `ExtractionResult`, `ProcessingReport`
    - Definir enum `ProcessingStatus` y tipos auxiliares
    - _Requirements: 2.1, 2.2_

  - [-] 4.2 Implementar inicialización y escaneo de carpeta
    - Implementar método `initialize()` que verifica/crea carpeta de PDFs
    - Implementar método `scanFolder()` que identifica archivos .pdf
    - Crear subcarpetas `processed/` y `failed/` si no existen
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [ ]* 4.3 Escribir property test para identificación de PDFs
    - **Property 1: Identificación completa de archivos PDF**
    - **Validates: Requirements 1.4, 1.5**
    - Generar carpetas con mezcla de archivos .pdf y otros
    - Verificar que scanFolder() identifica exactamente todos los .pdf

  - [-] 4.4 Implementar extracción de texto de PDFs
    - Implementar método `extractText()` usando pdf-parse
    - Preservar estructura de párrafos mediante análisis de saltos de línea
    - Manejar errores: PDFs protegidos, corruptos, ilegibles
    - Retornar `ExtractionResult` con metadata completa
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [ ]* 4.5 Escribir property test para extracción de texto
    - **Property 2: Extracción de texto completa**
    - **Validates: Requirements 2.1**
    - Generar PDFs válidos con contenido
    - Verificar que extractText() retorna éxito con texto no vacío

  - [ ]* 4.6 Escribir property test para preservación de párrafos
    - **Property 3: Preservación de estructura de párrafos**
    - **Validates: Requirements 2.2**
    - Generar PDFs con múltiples párrafos
    - Verificar que el resultado mantiene separación de párrafos

  - [~] 4.7 Implementar movimiento de archivos procesados
    - Implementar método `moveProcessedFile()` que mueve archivos según status
    - Mover exitosos a `processed/`, fallidos a `failed/`
    - _Requirements: 9.3, 9.4_

  - [ ]* 4.8 Escribir property tests para movimiento de archivos
    - **Property 26: Movimiento de archivos procesados exitosamente**
    - **Property 27: Movimiento de archivos con errores**
    - **Validates: Requirements 9.3, 9.4**
    - Verificar que archivos exitosos van a `processed/`
    - Verificar que archivos fallidos van a `failed/`

  - [~] 4.9 Implementar procesamiento por lotes
    - Implementar método `processAll()` que procesa archivos secuencialmente
    - Mantener registro de progreso (procesados/total)
    - Generar `ProcessingReport` con estadísticas completas
    - _Requirements: 9.1, 9.2, 9.5_

  - [ ]* 4.10 Escribir unit tests para PDF Processor
    - Test de inicialización y creación de carpetas
    - Test de manejo de errores (PDF protegido, corrupto)
    - Test de logging de operaciones
    - Test de procesamiento secuencial

- [~] 5. Checkpoint - Verificar procesamiento de PDFs
  - Ensure all tests pass, ask the user if questions arise.


- [ ] 6. Implementar Genkit Engine
  - [-] 6.1 Crear interfaces y tipos para análisis de IA
    - Definir interfaces: `GenkitEngine`, `AnalysisResult`, `Entity`, `Relationship`
    - Definir enum `EntityType` y tipos auxiliares
    - _Requirements: 4.2, 4.3_

  - [-] 6.2 Implementar inicialización de Genkit
    - Implementar método `initialize()` con configuración de Google API
    - Configurar modelo de lenguaje (Gemini) y modelo de embeddings
    - Implementar manejo de errores de API key inválida
    - _Requirements: 4.1_

  - [-] 6.3 Implementar análisis de texto para extracción de entidades
    - Implementar método `analyzeText()` con prompts estructurados
    - Identificar entidades: personas, lugares, organizaciones, conceptos
    - Normalizar nombres de entidades (capitalización, espacios)
    - Filtrar entidades con baja confianza
    - _Requirements: 4.2_

  - [ ]* 6.4 Escribir property test para identificación de entidades
    - **Property 5: Identificación de entidades en texto**
    - **Validates: Requirements 4.2**
    - Generar textos con entidades reconocibles
    - Verificar que analyzeText() retorna al menos una entidad

  - [~] 6.5 Implementar identificación de relaciones entre entidades
    - Extender `analyzeText()` para identificar relaciones
    - Normalizar tipos de relaciones (verbos)
    - Asignar confianza a cada relación
    - _Requirements: 4.3_

  - [ ]* 6.6 Escribir property test para identificación de relaciones
    - **Property 6: Identificación de relaciones entre entidades**
    - **Validates: Requirements 4.3**
    - Generar textos con múltiples entidades relacionadas
    - Verificar que analyzeText() identifica al menos una relación

  - [~] 6.7 Implementar generación de embeddings
    - Implementar método `generateEmbeddings()` usando modelo de Google
    - Implementar método `generateQueryEmbeddings()` para consultas
    - Manejar rate limiting y reintentos con backoff exponencial
    - _Requirements: 4.4, 7.1_

  - [ ]* 6.8 Escribir property test para dimensiones de embeddings
    - **Property 7: Generación de embeddings con dimensiones correctas**
    - **Validates: Requirements 4.4**
    - Generar textos válidos aleatorios
    - Verificar que embeddings tienen dimensiones configuradas (768)

  - [ ]* 6.9 Escribir property test para estructura de resultado
    - **Property 8: Estructura completa de resultado de análisis**
    - **Validates: Requirements 4.5**
    - Verificar que AnalysisResult contiene todos los campos requeridos
    - Verificar tipos correctos para cada campo

  - [ ]* 6.10 Escribir unit tests para Genkit Engine
    - Test de inicialización exitosa y fallida
    - Test de manejo de rate limiting
    - Test de reintentos con backoff exponencial
    - Test de logging de errores de API

- [~] 7. Checkpoint - Verificar análisis de IA
  - Ensure all tests pass, ask the user if questions arise.


- [ ] 8. Implementar Knowledge Graph Builder
  - [-] 8.1 Crear interfaces y tipos para construcción del grafo
    - Definir interfaces: `KnowledgeGraphBuilder`, `GraphStats`, `SearchResult`, `GraphContext`
    - Definir tipos auxiliares para Neo4j
    - _Requirements: 5.1, 5.2, 5.3_

  - [-] 8.2 Implementar conexión a Neo4j
    - Implementar método `connect()` usando neo4j-driver
    - Implementar método `disconnect()` para cerrar conexión
    - Manejar errores de conexión con reintentos y backoff exponencial
    - _Requirements: 5.1_

  - [-] 8.3 Crear esquema e índices en Neo4j
    - Crear constraints para nodos Entity (id único)
    - Crear índice vectorial para embeddings con configuración cosine similarity
    - Implementar script de inicialización de esquema
    - _Requirements: 5.4_

  - [~] 8.4 Implementar creación y actualización de nodos
    - Implementar método `createOrUpdateEntity()` con lógica de merge
    - Crear nodo nuevo si no existe, actualizar si existe
    - Almacenar propiedades: id, name, type, sourceText, embeddings, documents
    - Agregar documento a lista de fuentes en actualizaciones
    - _Requirements: 5.2, 5.5, 5.6_

  - [ ]* 8.5 Escribir property test para creación de nodos
    - **Property 9: Creación de nodos con propiedades completas**
    - **Validates: Requirements 5.2**
    - Generar entidades válidas aleatorias
    - Verificar que nodos creados contienen todas las propiedades requeridas

  - [ ]* 8.6 Escribir property test para almacenamiento de embeddings
    - **Property 11: Almacenamiento de embeddings en nodos**
    - **Validates: Requirements 5.4**
    - Verificar que embeddings se almacenan correctamente como propiedad

  - [ ]* 8.7 Escribir property test para asociación con documento
    - **Property 12: Asociación de nodos con documento fuente**
    - **Validates: Requirements 5.5**
    - Verificar que cada nodo contiene referencia al PDF de origen

  - [ ]* 8.8 Escribir property test para merge idempotente
    - **Property 13: Actualización idempotente de entidades (Merge)**
    - **Validates: Requirements 5.6**
    - Procesar misma entidad dos veces
    - Verificar que solo existe un nodo y contiene ambos documentos

  - [~] 8.9 Implementar creación de relaciones
    - Implementar método `createRelationship()` para crear aristas dirigidas
    - Almacenar propiedades: type, sourceDocument, confidence, createdAt
    - Usar transacciones para garantizar consistencia
    - _Requirements: 5.3_

  - [ ]* 8.10 Escribir property test para relaciones dirigidas
    - **Property 10: Creación de relaciones dirigidas**
    - **Validates: Requirements 5.3**
    - Generar relaciones válidas entre entidades existentes
    - Verificar que se crea arista dirigida correcta en Neo4j

  - [~] 8.11 Implementar procesamiento completo de análisis
    - Implementar método `processAnalysisResult()` que procesa entidades y relaciones
    - Ejecutar en transacción para atomicidad
    - Retornar `GraphStats` con contadores de operaciones
    - Registrar estadísticas de cada operación
    - _Requirements: 5.7, 8.2_

  - [ ]* 8.12 Escribir property test para registro de estadísticas
    - **Property 22: Registro de estadísticas de grafo**
    - **Validates: Requirements 8.2**
    - Verificar que se registra número exacto de entidades y relaciones creadas

  - [~] 8.13 Implementar búsqueda vectorial
    - Implementar método `vectorSearch()` usando índice vectorial de Neo4j
    - Ejecutar consulta de similitud coseno
    - Ordenar resultados por puntuación descendente
    - Incluir contexto (nodos vecinos) en resultados
    - _Requirements: 7.2, 7.3, 7.4_

  - [ ]* 8.14 Escribir property test para ordenamiento de resultados
    - **Property 18: Ordenamiento de resultados de búsqueda por similitud**
    - **Validates: Requirements 7.3**
    - Verificar que resultados están ordenados descendentemente por similitud

  - [ ]* 8.15 Escribir property test para inclusión de contexto
    - **Property 19: Inclusión de contexto en resultados de búsqueda**
    - **Validates: Requirements 7.4**
    - Verificar que cada resultado incluye información de nodos vecinos

  - [~] 8.16 Implementar obtención de contexto de nodo
    - Implementar método `getNodeContext()` que obtiene vecinos a profundidad N
    - Retornar nodos conectados con tipo y dirección de relación
    - _Requirements: 7.4_

  - [ ]* 8.17 Escribir unit tests para Knowledge Graph Builder
    - Test de conexión exitosa y fallida a Neo4j
    - Test de transacciones y rollback en errores
    - Test de reintentos con backoff exponencial
    - Test de logging de operaciones

- [~] 9. Checkpoint - Verificar construcción del grafo
  - Ensure all tests pass, ask the user if questions arise.


- [ ] 10. Implementar Visualization Service
  - [-] 10.1 Crear interfaces y tipos para visualización
    - Definir interfaces: `VisualizationService`, `GraphData`, `NodeDetails`, `VisualizationData`
    - Definir tipos para filtros y opciones de visualización
    - _Requirements: 6.1, 6.2_

  - [-] 10.2 Implementar consulta de grafo completo
    - Implementar método `getGraph()` que consulta Neo4j
    - Soportar filtros opcionales: tipos de entidad, documentos fuente, límite de nodos
    - Retornar nodos y aristas en formato `GraphData`
    - _Requirements: 6.1, 6.3, 6.4_

  - [ ]* 10.3 Escribir property test para generación de visualización
    - **Property 14: Generación de visualización con nodos y aristas**
    - **Validates: Requirements 6.2**
    - Verificar que visualización contiene un nodo por entidad y arista por relación

  - [ ]* 10.4 Escribir property test para filtrado
    - **Property 15: Filtrado de visualización por criterios**
    - **Validates: Requirements 6.3, 6.4**
    - Generar filtros válidos aleatorios
    - Verificar que resultados son subconjunto del grafo completo

  - [~] 10.5 Implementar consultas filtradas
    - Implementar método `getNodesByType()` para filtrar por tipo de entidad
    - Implementar método `getNodesByDocument()` para filtrar por documento
    - _Requirements: 6.3, 6.4_

  - [~] 10.6 Implementar obtención de detalles de nodo
    - Implementar método `getNodeDetails()` que retorna propiedades completas
    - Incluir texto fuente, documentos, y contexto (vecinos)
    - _Requirements: 6.5_

  - [ ]* 10.7 Escribir property test para acceso a detalles
    - **Property 16: Acceso a detalles de nodo**
    - **Validates: Requirements 6.5**
    - Verificar que se pueden obtener propiedades y texto fuente de cualquier nodo

  - [~] 10.8 Implementar generación de datos de visualización
    - Implementar método `generateVisualizationData()` que transforma a formato de biblioteca
    - Asignar colores por tipo de entidad
    - Calcular tamaño de nodos basado en número de conexiones
    - Formatear aristas con etiquetas y colores
    - _Requirements: 6.2, 6.6_

  - [~] 10.9 Implementar resaltado de resultados de búsqueda
    - Agregar propiedad de resaltado a nodos encontrados en búsqueda
    - Modificar `generateVisualizationData()` para marcar nodos resaltados
    - _Requirements: 7.5_

  - [ ]* 10.10 Escribir property test para resaltado de nodos
    - **Property 20: Resaltado de nodos encontrados**
    - **Validates: Requirements 7.5**
    - Verificar que nodos de búsqueda tienen marcador de resaltado

  - [ ]* 10.11 Escribir unit tests para Visualization Service
    - Test de consultas con diferentes filtros
    - Test de manejo de nodos inexistentes
    - Test de generación de colores y tamaños
    - Test de formato de datos de visualización

- [~] 11. Checkpoint - Verificar visualización
  - Ensure all tests pass, ask the user if questions arise.


- [ ] 12. Implementar sistema de logging
  - [-] 12.1 Crear interfaces y tipos para logging
    - Definir interface `Logger` con métodos para cada nivel
    - Definir interface `LogEntry` con estructura de log
    - Definir enum para niveles de log (ERROR, WARN, INFO, DEBUG)
    - _Requirements: 8.1, 8.2_

  - [-] 12.2 Implementar Logger con niveles
    - Implementar métodos: `error()`, `warn()`, `info()`, `debug()`
    - Incluir timestamp, componente, mensaje, contexto en cada entrada
    - Incluir stack trace completo en errores críticos
    - Formatear salida para legibilidad
    - _Requirements: 8.1, 8.2, 8.6_

  - [ ]* 12.3 Escribir property test para registro de procesamiento
    - **Property 21: Registro de procesamiento de archivos**
    - **Validates: Requirements 8.1**
    - Verificar que cada PDF procesado tiene entrada de log con timestamp y estado

  - [ ]* 12.4 Escribir property test para logging de advertencias
    - **Property 23: Registro de advertencias para credenciales opcionales**
    - **Validates: Requirements 8.5**
    - Verificar que credenciales opcionales faltantes generan advertencias

  - [ ]* 12.5 Escribir property test para stack traces
    - **Property 24: Registro de stack trace en errores críticos**
    - **Validates: Requirements 8.6**
    - Verificar que errores críticos incluyen stack trace completo

  - [-] 12.3 Integrar Logger en todos los componentes
    - Agregar instancia de Logger a cada componente
    - Registrar eventos importantes: inicio, fin, errores, advertencias
    - Registrar estadísticas de operaciones
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [ ]* 12.4 Escribir unit tests para Logger
    - Test de formato de entradas de log
    - Test de niveles de log
    - Test de inclusión de contexto y stack traces

- [ ] 13. Implementar manejo de errores
  - [x] 13.1 Crear clases de error personalizadas
    - Implementar `ConfigurationError` con campos específicos
    - Implementar `PDFProcessingError` con tipo de error
    - Implementar `GenkitAPIError` con código de estado
    - Implementar `Neo4jError` con código de error
    - Implementar `VisualizationError` con tipo de error
    - _Requirements: 8.3, 8.4_

  - [-] 13.2 Implementar estrategia de reintentos
    - Implementar función `retryWithBackoff()` genérica
    - Configurar reintentos para Genkit Engine (rate limiting, timeouts)
    - Configurar reintentos para Knowledge Graph Builder (conexión, transacciones)
    - Usar backoff exponencial con límite máximo
    - _Requirements: 8.3_

  - [~] 13.3 Integrar manejo de errores en componentes
    - Agregar try-catch en métodos críticos
    - Clasificar errores como recuperables o no recuperables
    - Registrar errores con Logger
    - Propagar errores críticos, manejar recuperables localmente
    - _Requirements: 8.3, 8.4_

  - [ ]* 13.4 Escribir unit tests para manejo de errores
    - Test de clasificación de errores (recuperable vs no recuperable)
    - Test de reintentos con backoff exponencial
    - Test de propagación de errores críticos
    - Test de logging de errores

- [~] 14. Checkpoint - Verificar logging y manejo de errores
  - Ensure all tests pass, ask the user if questions arise.


- [ ] 15. Integrar componentes en aplicación principal
  - [~] 15.1 Crear punto de entrada principal
    - Crear archivo `src/index.ts` como punto de entrada
    - Inicializar Configuration Manager y cargar configuración
    - Validar configuración antes de continuar
    - _Requirements: 3.1, 3.4_

  - [~] 15.2 Inicializar servicios
    - Inicializar Logger
    - Inicializar Genkit Engine con configuración de Google
    - Conectar Knowledge Graph Builder a Neo4j
    - Inicializar PDF Processor con carpeta configurada
    - Manejar errores de inicialización
    - _Requirements: 4.1, 5.1, 1.1_

  - [~] 15.3 Implementar flujo de procesamiento completo
    - Escanear carpeta de PDFs
    - Para cada PDF: extraer texto → analizar con Genkit → construir grafo
    - Mover archivos procesados según resultado
    - Registrar progreso y estadísticas
    - _Requirements: 1.5, 2.5, 4.5, 5.7, 9.1, 9.2, 9.5_

  - [ ]* 15.4 Escribir property test para procesamiento en orden
    - **Property 25: Procesamiento en orden de archivos**
    - **Validates: Requirements 9.1**
    - Generar conjunto de archivos con timestamps diferentes
    - Verificar que se procesan en orden cronológico

  - [ ]* 15.5 Escribir property test para actualización de progreso
    - **Property 28: Actualización de progreso de procesamiento**
    - **Validates: Requirements 9.5**
    - Verificar que suma de procesados + pendientes = total

  - [~] 15.6 Implementar interfaz de búsqueda vectorial
    - Crear función que acepta consulta de texto
    - Generar embeddings de consulta con Genkit
    - Ejecutar búsqueda vectorial en Knowledge Graph Builder
    - Retornar resultados con contexto
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [ ]* 15.7 Escribir property test para embeddings de consulta
    - **Property 17: Generación de embeddings para consultas**
    - **Validates: Requirements 7.1**
    - Generar consultas válidas aleatorias
    - Verificar que embeddings tienen mismas dimensiones que documentos

  - [~] 15.8 Implementar interfaz de visualización
    - Crear función que obtiene grafo con filtros opcionales
    - Generar datos de visualización con Visualization Service
    - Soportar resaltado de resultados de búsqueda
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 7.5_

  - [~] 15.9 Implementar cierre limpio de recursos
    - Desconectar de Neo4j al finalizar
    - Cerrar archivos y liberar recursos
    - Registrar resumen final de operaciones
    - _Requirements: 5.1_

  - [ ]* 15.10 Escribir integration tests end-to-end
    - Test de flujo completo: PDF → extracción → análisis → grafo → visualización
    - Test de procesamiento de múltiples PDFs
    - Test de búsqueda vectorial con resultados
    - Test de manejo de errores en flujo completo

- [~] 16. Checkpoint final - Verificar integración completa
  - Ensure all tests pass, ask the user if questions arise.


- [ ] 17. Crear documentación y ejemplos
  - [~] 17.1 Crear README.md del proyecto
    - Documentar descripción general del sistema
    - Documentar requisitos previos (Node.js, Neo4j, Google API key)
    - Documentar pasos de instalación y configuración
    - Incluir ejemplo de archivo .env
    - Documentar comandos de ejecución

  - [~] 17.2 Crear documentación de API
    - Documentar interfaces públicas de cada componente
    - Incluir ejemplos de uso para cada método principal
    - Documentar tipos de error y cómo manejarlos

  - [~] 17.3 Crear scripts de utilidad
    - Crear script de inicialización de esquema Neo4j
    - Crear script de limpieza de base de datos
    - Crear script de ejemplo con PDFs de prueba

  - [~] 17.4 Crear guía de troubleshooting
    - Documentar errores comunes y soluciones
    - Documentar cómo verificar conexión a Neo4j
    - Documentar cómo verificar configuración de Google API

## Notes

- **Lenguaje de implementación**: TypeScript con Node.js
- **Framework de testing**: Jest con fast-check para property-based testing
- **Tareas marcadas con `*`**: Son opcionales y pueden omitirse para un MVP más rápido
- **Property-based tests**: Cada test debe incluir comentario con formato `// Feature: pdf-knowledge-graph, Property {number}: {property_text}`
- **Configuración de fast-check**: Mínimo 100 iteraciones por test (`{ numRuns: 100 }`)
- **Checkpoints**: Puntos de validación donde se verifica que todos los tests pasan antes de continuar
- **Procesamiento incremental**: Cada tarea construye sobre las anteriores y valida funcionalidad tempranamente
- **Cobertura de requisitos**: Cada tarea referencia los requisitos específicos que implementa mediante `_Requirements: X.Y_`
- **Transacciones**: Usar transacciones de Neo4j para garantizar consistencia en operaciones de grafo
- **Reintentos**: Implementar backoff exponencial para errores recuperables (rate limiting, conexión)
- **Logging**: Registrar todas las operaciones importantes con timestamp, componente y contexto

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "4.1", "6.1", "8.1", "10.1", "12.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "4.2", "6.2", "8.2", "10.2", "12.2", "13.1"] },
    { "id": 3, "tasks": ["2.4", "2.5", "2.6", "4.3", "4.4", "6.3", "8.3", "10.3", "10.4", "12.3", "13.2"] },
    { "id": 4, "tasks": ["4.5", "4.6", "4.7", "6.4", "6.5", "8.4", "10.5", "12.4", "13.3"] },
    { "id": 5, "tasks": ["4.8", "4.9", "6.6", "6.7", "8.5", "8.6", "8.7", "8.8", "8.9", "10.6", "13.4"] },
    { "id": 6, "tasks": ["4.10", "6.8", "6.9", "6.10", "8.10", "8.11", "10.7", "10.8"] },
    { "id": 7, "tasks": ["8.12", "8.13", "10.9"] },
    { "id": 8, "tasks": ["8.14", "8.15", "8.16", "10.10", "10.11"] },
    { "id": 9, "tasks": ["8.17", "12.3"] },
    { "id": 10, "tasks": ["15.1"] },
    { "id": 11, "tasks": ["15.2"] },
    { "id": 12, "tasks": ["15.3", "15.6", "15.8"] },
    { "id": 13, "tasks": ["15.4", "15.5", "15.7", "15.9"] },
    { "id": 14, "tasks": ["15.10"] },
    { "id": 15, "tasks": ["17.1", "17.2", "17.3", "17.4"] }
  ]
}
```
