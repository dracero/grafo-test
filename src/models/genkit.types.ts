/**
 * Tipos e interfaces para el motor de análisis de IA con Google Genkit
 * Feature: pdf-knowledge-graph
 * Requirements: 4.2, 4.3
 */

/**
 * Tipos de entidades que pueden ser identificadas en el texto
 */
export enum EntityType {
  PERSON = 'PERSON',
  ORGANIZATION = 'ORGANIZATION',
  LOCATION = 'LOCATION',
  CONCEPT = 'CONCEPT',
  DATE = 'DATE',
  OTHER = 'OTHER'
}

/**
 * Representa una entidad extraída del texto
 */
export interface Entity {
  /** Nombre de la entidad */
  name: string;
  
  /** Tipo de entidad */
  type: EntityType;
  
  /** Fragmento de texto donde se encontró la entidad */
  sourceText: string;
  
  /** Nivel de confianza del modelo (0-1) */
  confidence: number;
}

/**
 * Representa una relación entre dos entidades
 */
export interface Relationship {
  /** Nombre de la entidad origen */
  source: string;
  
  /** Nombre de la entidad destino */
  target: string;
  
  /** Tipo de relación (e.g., "WORKS_AT", "LOCATED_IN") */
  type: string;
  
  /** Nivel de confianza del modelo (0-1) */
  confidence: number;
}

/**
 * Resultado del análisis de texto con IA
 */
export interface AnalysisResult {
  /** Lista de entidades identificadas */
  entities: Entity[];
  
  /** Lista de relaciones identificadas entre entidades */
  relationships: Relationship[];
  
  /** Vector de embeddings para el texto */
  embeddings: number[];
  
  /** Texto original que fue analizado */
  sourceText: string;
}

/**
 * Configuración de Google API para Genkit
 */
export interface GoogleConfig {
  /** API key de Google */
  apiKey: string;
}

/**
 * Motor de análisis de texto con Google Genkit
 */
export interface GenkitEngine {
  /**
   * Inicializa el motor con la configuración de Google API
   * @param config Configuración de Google API
   * @throws Error si la API key es inválida
   */
  initialize(config: GoogleConfig): Promise<void>;
  
  /**
   * Analiza texto y extrae entidades y relaciones
   * @param text Texto a analizar
   * @returns Resultado del análisis con entidades, relaciones y embeddings
   * @throws Error si el análisis falla
   */
  analyzeText(text: string): Promise<AnalysisResult>;
  
  /**
   * Genera embeddings vectoriales para un texto
   * @param text Texto para generar embeddings
   * @returns Vector de embeddings
   * @throws Error si la generación falla
   */
  generateEmbeddings(text: string): Promise<number[]>;
  
  /**
   * Genera embeddings para una consulta de búsqueda
   * @param query Consulta de búsqueda
   * @returns Vector de embeddings para la consulta
   * @throws Error si la generación falla
   */
  generateQueryEmbeddings(query: string): Promise<number[]>;
}
