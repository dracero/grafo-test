# Requirements Document

## Introduction

Este documento define los requisitos para un sistema de procesamiento de documentos PDF que extrae información, construye un grafo de conocimiento en Neo4j, y proporciona visualización de las entidades y relaciones extraídas. El sistema utiliza Google Genkit como framework de IA para el procesamiento y análisis de documentos, con integración nativa de búsqueda vectorial en Neo4j.

## Glossary

- **PDF_Processor**: Componente que lee y extrae texto de archivos PDF
- **Knowledge_Graph_Builder**: Componente que analiza el texto extraído y construye nodos y relaciones en Neo4j
- **Neo4j_Database**: Base de datos de grafos que almacena entidades y relaciones
- **Genkit_Engine**: Framework de Google Genkit que proporciona capacidades de IA para análisis de texto
- **Configuration_Manager**: Componente que gestiona credenciales y configuración desde archivo .env
- **Visualization_Service**: Componente que genera visualizaciones del grafo de conocimiento
- **PDF_Folder**: Directorio del sistema de archivos que contiene documentos PDF para procesar
- **Entity**: Nodo en el grafo que representa un concepto, persona, lugar u objeto extraído del texto
- **Relationship**: Conexión dirigida entre dos entidades en el grafo
- **Vector_Embeddings**: Representaciones vectoriales de texto para búsqueda semántica

## Requirements

### Requirement 1: Gestión de Carpeta de PDFs

**User Story:** Como usuario, quiero que el sistema monitoree una carpeta específica para documentos PDF, para que pueda simplemente colocar archivos y que sean procesados automáticamente.

#### Acceptance Criteria

1. THE Configuration_Manager SHALL cargar la ruta de PDF_Folder desde el archivo .env
2. WHEN el sistema inicia, THE PDF_Processor SHALL verificar que PDF_Folder existe
3. IF PDF_Folder no existe, THEN THE PDF_Processor SHALL crear el directorio
4. THE PDF_Processor SHALL identificar todos los archivos con extensión .pdf en PDF_Folder
5. WHEN un archivo PDF es detectado en PDF_Folder, THE PDF_Processor SHALL agregarlo a la cola de procesamiento

### Requirement 2: Extracción de Texto de PDFs

**User Story:** Como usuario, quiero que el sistema extraiga texto de documentos PDF, para que el contenido pueda ser analizado.

#### Acceptance Criteria

1. WHEN un archivo PDF es procesado, THE PDF_Processor SHALL extraer todo el texto del documento
2. THE PDF_Processor SHALL preservar la estructura de párrafos durante la extracción
3. IF un PDF está protegido con contraseña, THEN THE PDF_Processor SHALL registrar un error y marcar el documento como no procesable
4. IF un PDF está corrupto o no puede ser leído, THEN THE PDF_Processor SHALL registrar un error con el nombre del archivo
5. WHEN la extracción es exitosa, THE PDF_Processor SHALL pasar el texto extraído al Knowledge_Graph_Builder

### Requirement 3: Configuración de Credenciales

**User Story:** Como desarrollador, quiero que todas las credenciales se almacenen en un archivo .env, para que la configuración sea segura y fácil de gestionar.

#### Acceptance Criteria

1. THE Configuration_Manager SHALL cargar las credenciales de Neo4j (URI, usuario, contraseña) desde el archivo .env
2. THE Configuration_Manager SHALL cargar las API keys de Google desde el archivo .env
3. THE Configuration_Manager SHALL cargar la ruta de PDF_Folder desde el archivo .env
4. IF el archivo .env no existe, THEN THE Configuration_Manager SHALL registrar un error y detener la ejecución
5. IF alguna credencial requerida falta en el archivo .env, THEN THE Configuration_Manager SHALL registrar un error especificando qué credencial falta
6. THE Configuration_Manager SHALL proporcionar acceso a las credenciales a otros componentes del sistema

### Requirement 4: Integración con Google Genkit

**User Story:** Como desarrollador, quiero utilizar Google Genkit para el análisis de texto con IA, para que pueda extraer entidades y relaciones de manera inteligente.

#### Acceptance Criteria

1. THE Genkit_Engine SHALL inicializarse con las API keys de Google proporcionadas por Configuration_Manager
2. WHEN el texto es recibido para análisis, THE Genkit_Engine SHALL identificar entidades (personas, lugares, organizaciones, conceptos)
3. THE Genkit_Engine SHALL identificar relaciones entre entidades extraídas
4. THE Genkit_Engine SHALL generar Vector_Embeddings para cada fragmento de texto procesado
5. WHEN el análisis es completado, THE Genkit_Engine SHALL retornar una estructura con entidades, relaciones y embeddings

### Requirement 5: Construcción del Grafo de Conocimiento

**User Story:** Como usuario, quiero que el sistema construya un grafo de conocimiento en Neo4j, para que pueda visualizar y consultar las relaciones entre conceptos.

#### Acceptance Criteria

1. THE Knowledge_Graph_Builder SHALL conectarse a Neo4j_Database usando credenciales de Configuration_Manager
2. WHEN una Entity es identificada, THE Knowledge_Graph_Builder SHALL crear un nodo en Neo4j_Database con propiedades (nombre, tipo, texto_fuente)
3. WHEN una Relationship es identificada, THE Knowledge_Graph_Builder SHALL crear una relación dirigida entre los nodos correspondientes
4. THE Knowledge_Graph_Builder SHALL almacenar Vector_Embeddings como propiedades de los nodos para búsqueda vectorial
5. THE Knowledge_Graph_Builder SHALL asociar cada nodo con el documento PDF de origen
6. IF un nodo con la misma entidad ya existe, THEN THE Knowledge_Graph_Builder SHALL actualizar sus propiedades y agregar referencia al nuevo documento
7. WHEN el procesamiento de un documento es completado, THE Knowledge_Graph_Builder SHALL confirmar la transacción en Neo4j_Database

### Requirement 6: Visualización del Grafo

**User Story:** Como usuario, quiero visualizar el grafo de conocimiento, para que pueda explorar las entidades y relaciones extraídas de los documentos.

#### Acceptance Criteria

1. THE Visualization_Service SHALL consultar Neo4j_Database para obtener nodos y relaciones
2. THE Visualization_Service SHALL generar una representación visual del grafo con nodos y aristas
3. THE Visualization_Service SHALL permitir filtrar la visualización por tipo de entidad
4. THE Visualization_Service SHALL permitir filtrar la visualización por documento de origen
5. WHEN un nodo es seleccionado en la visualización, THE Visualization_Service SHALL mostrar sus propiedades y texto fuente
6. THE Visualization_Service SHALL soportar navegación interactiva del grafo (zoom, pan, selección)

### Requirement 7: Búsqueda Vectorial

**User Story:** Como usuario, quiero buscar información semánticamente en el grafo, para que pueda encontrar conceptos relacionados incluso si no comparten palabras exactas.

#### Acceptance Criteria

1. WHEN una consulta de búsqueda es recibida, THE Genkit_Engine SHALL generar Vector_Embeddings para la consulta
2. THE Knowledge_Graph_Builder SHALL ejecutar búsqueda de similitud vectorial en Neo4j_Database
3. THE Knowledge_Graph_Builder SHALL retornar los nodos más similares ordenados por puntuación de similitud
4. THE Knowledge_Graph_Builder SHALL incluir el contexto (nodos vecinos) de los resultados encontrados
5. THE Visualization_Service SHALL resaltar los nodos encontrados en la visualización

### Requirement 8: Manejo de Errores y Logging

**User Story:** Como desarrollador, quiero que el sistema registre errores y eventos importantes, para que pueda diagnosticar problemas y monitorear el procesamiento.

#### Acceptance Criteria

1. THE PDF_Processor SHALL registrar cada archivo PDF procesado con timestamp y estado (éxito/error)
2. THE Knowledge_Graph_Builder SHALL registrar el número de entidades y relaciones creadas por documento
3. IF la conexión a Neo4j_Database falla, THEN THE Knowledge_Graph_Builder SHALL registrar el error y reintentar la conexión
4. IF la API de Google falla, THEN THE Genkit_Engine SHALL registrar el error con detalles de la solicitud
5. THE Configuration_Manager SHALL registrar advertencias si credenciales opcionales no están presentes
6. WHEN un error crítico ocurre, THE sistema SHALL registrar el stack trace completo

### Requirement 9: Procesamiento por Lotes

**User Story:** Como usuario, quiero que el sistema procese múltiples PDFs eficientemente, para que pueda cargar grandes colecciones de documentos.

#### Acceptance Criteria

1. THE PDF_Processor SHALL procesar archivos PDF en el orden en que fueron agregados a PDF_Folder
2. THE PDF_Processor SHALL procesar un documento a la vez para evitar sobrecarga de memoria
3. WHEN un documento es procesado completamente, THE PDF_Processor SHALL moverlo a una subcarpeta "processed"
4. IF el procesamiento de un documento falla, THEN THE PDF_Processor SHALL moverlo a una subcarpeta "failed"
5. THE PDF_Processor SHALL mantener un registro de progreso (documentos procesados/total)

### Requirement 10: Parseo y Serialización de Configuración

**User Story:** Como desarrollador, quiero que el sistema parsee correctamente el archivo .env, para que la configuración sea confiable.

#### Acceptance Criteria

1. WHEN el archivo .env es leído, THE Configuration_Manager SHALL parsearlo en un objeto de configuración
2. WHEN se necesita validar la configuración, THE Configuration_Manager SHALL verificar que todos los campos requeridos están presentes
3. THE Configuration_Manager SHALL proporcionar un método para serializar la configuración actual a formato .env
4. FOR ALL objetos de configuración válidos, parsear el archivo .env, serializar a string, y parsear nuevamente SHALL producir un objeto equivalente (propiedad round-trip)
