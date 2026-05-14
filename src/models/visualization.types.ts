/**
 * Tipos e interfaces para el servicio de visualización del grafo de conocimiento
 * Feature: pdf-knowledge-graph
 * Requirements: 6.1, 6.2
 */

import { Entity, EntityType } from './genkit.types';

/**
 * Filtros para consultas de grafo
 */
export interface GraphFilters {
  /** Tipos de entidad a incluir en la visualización */
  entityTypes?: EntityType[];
  /** Nombres de documentos fuente para filtrar */
  sourceDocuments?: string[];
  /** Número máximo de nodos a retornar */
  maxNodes?: number;
}

/**
 * Datos del grafo en formato estructurado
 */
export interface GraphData {
  /** Lista de nodos (entidades) del grafo */
  nodes: Entity[];
  /** Lista de aristas (relaciones) del grafo */
  edges: GraphEdge[];
}

/**
 * Representación de una arista en el grafo
 */
export interface GraphEdge {
  /** ID de la entidad origen */
  source: string;
  /** ID de la entidad destino */
  target: string;
  /** Tipo de relación */
  type: string;
  /** Nivel de confianza de la relación (0-1) */
  confidence: number;
}

/**
 * Detalles completos de un nodo del grafo
 */
export interface NodeDetails {
  /** Entidad asociada al nodo */
  entity: Entity;
  /** Propiedades adicionales del nodo */
  properties: Record<string, any>;
  /** Lista de documentos fuente donde aparece la entidad */
  sourceDocuments: string[];
  /** Contexto del nodo (nodos vecinos) */
  neighbors: GraphContext;
}

/**
 * Contexto de un nodo en el grafo (nodos conectados)
 */
export interface GraphContext {
  /** Nodo central */
  centerNode: Entity;
  /** Lista de nodos vecinos con información de relación */
  neighbors: NeighborInfo[];
}

/**
 * Información de un nodo vecino
 */
export interface NeighborInfo {
  /** Entidad vecina */
  entity: Entity;
  /** Tipo de relación con el nodo central */
  relationship: string;
  /** Dirección de la relación */
  direction: 'incoming' | 'outgoing';
}

/**
 * Datos de visualización en formato compatible con bibliotecas de grafos
 * (e.g., vis.js, cytoscape.js)
 */
export interface VisualizationData {
  /** Nodos formateados para visualización */
  nodes: VisualizationNode[];
  /** Aristas formateadas para visualización */
  edges: VisualizationEdge[];
}

/**
 * Nodo formateado para visualización
 */
export interface VisualizationNode {
  /** ID único del nodo */
  id: string;
  /** Etiqueta a mostrar */
  label: string;
  /** Tipo de entidad */
  type: string;
  /** Color del nodo */
  color: string;
  /** Tamaño del nodo */
  size: number;
  /** Indica si el nodo está resaltado (e.g., resultado de búsqueda) */
  highlighted?: boolean;
}

/**
 * Arista formateada para visualización
 */
export interface VisualizationEdge {
  /** ID único de la arista */
  id: string;
  /** ID del nodo origen */
  source: string;
  /** ID del nodo destino */
  target: string;
  /** Etiqueta de la relación */
  label: string;
  /** Color de la arista */
  color: string;
}

/**
 * Opciones de visualización
 */
export interface VisualizationOptions {
  /** Esquema de colores por tipo de entidad */
  colorScheme?: Record<EntityType, string>;
  /** Tamaño base de los nodos */
  baseNodeSize?: number;
  /** Factor de escala para tamaño de nodos según conexiones */
  nodeSizeScale?: number;
  /** Color por defecto para aristas */
  defaultEdgeColor?: string;
  /** Mostrar etiquetas de aristas */
  showEdgeLabels?: boolean;
}

/**
 * Servicio de visualización del grafo de conocimiento
 */
export interface VisualizationService {
  /**
   * Obtiene todos los nodos y relaciones del grafo con filtros opcionales
   * @param filters - Filtros opcionales para la consulta
   * @returns Datos del grafo
   */
  getGraph(filters?: GraphFilters): Promise<GraphData>;

  /**
   * Obtiene nodos filtrados por tipo de entidad
   * @param entityType - Tipo de entidad a filtrar
   * @returns Lista de entidades del tipo especificado
   */
  getNodesByType(entityType: EntityType): Promise<Entity[]>;

  /**
   * Obtiene nodos filtrados por documento fuente
   * @param documentName - Nombre del documento fuente
   * @returns Lista de entidades del documento especificado
   */
  getNodesByDocument(documentName: string): Promise<Entity[]>;

  /**
   * Obtiene detalles completos de un nodo
   * @param nodeId - ID del nodo
   * @returns Detalles completos del nodo
   */
  getNodeDetails(nodeId: string): Promise<NodeDetails>;

  /**
   * Genera datos de visualización en formato compatible con bibliotecas de grafos
   * @param graphData - Datos del grafo
   * @param options - Opciones de visualización
   * @returns Datos formateados para visualización
   */
  generateVisualizationData(
    graphData: GraphData,
    options?: VisualizationOptions
  ): Promise<VisualizationData>;
}
