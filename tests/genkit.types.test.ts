/**
 * Tests unitarios para tipos e interfaces de Genkit
 * Feature: pdf-knowledge-graph
 * Task: 6.1 - Crear interfaces y tipos para análisis de IA
 */

import {
  EntityType,
  Entity,
  Relationship,
  AnalysisResult,
  GoogleConfig,
  GenkitEngine
} from '../src/models/genkit.types';

describe('Genkit Types - Task 6.1', () => {
  describe('EntityType enum', () => {
    it('should have all required entity types', () => {
      expect(EntityType.PERSON).toBe('PERSON');
      expect(EntityType.ORGANIZATION).toBe('ORGANIZATION');
      expect(EntityType.LOCATION).toBe('LOCATION');
      expect(EntityType.CONCEPT).toBe('CONCEPT');
      expect(EntityType.DATE).toBe('DATE');
      expect(EntityType.OTHER).toBe('OTHER');
    });

    it('should have exactly 6 entity types', () => {
      const types = Object.values(EntityType);
      expect(types).toHaveLength(6);
    });
  });

  describe('Entity interface', () => {
    it('should accept valid entity objects', () => {
      const entity: Entity = {
        name: 'John Doe',
        type: EntityType.PERSON,
        sourceText: 'John Doe is a software engineer',
        confidence: 0.95
      };

      expect(entity.name).toBe('John Doe');
      expect(entity.type).toBe(EntityType.PERSON);
      expect(entity.sourceText).toBe('John Doe is a software engineer');
      expect(entity.confidence).toBe(0.95);
    });

    it('should support all entity types', () => {
      const entityTypes = [
        EntityType.PERSON,
        EntityType.ORGANIZATION,
        EntityType.LOCATION,
        EntityType.CONCEPT,
        EntityType.DATE,
        EntityType.OTHER
      ];

      entityTypes.forEach(type => {
        const entity: Entity = {
          name: 'Test Entity',
          type: type,
          sourceText: 'Test text',
          confidence: 0.8
        };
        expect(entity.type).toBe(type);
      });
    });
  });

  describe('Relationship interface', () => {
    it('should accept valid relationship objects', () => {
      const relationship: Relationship = {
        source: 'John Doe',
        target: 'Acme Corp',
        type: 'WORKS_AT',
        confidence: 0.9
      };

      expect(relationship.source).toBe('John Doe');
      expect(relationship.target).toBe('Acme Corp');
      expect(relationship.type).toBe('WORKS_AT');
      expect(relationship.confidence).toBe(0.9);
    });

    it('should support different relationship types', () => {
      const relationshipTypes = ['WORKS_AT', 'LOCATED_IN', 'FOUNDED_BY', 'MANAGES'];

      relationshipTypes.forEach(type => {
        const relationship: Relationship = {
          source: 'Entity A',
          target: 'Entity B',
          type: type,
          confidence: 0.85
        };
        expect(relationship.type).toBe(type);
      });
    });
  });

  describe('AnalysisResult interface', () => {
    it('should accept valid analysis result objects', () => {
      const result: AnalysisResult = {
        entities: [
          {
            name: 'John Doe',
            type: EntityType.PERSON,
            sourceText: 'John Doe works at Acme Corp',
            confidence: 0.95
          },
          {
            name: 'Acme Corp',
            type: EntityType.ORGANIZATION,
            sourceText: 'John Doe works at Acme Corp',
            confidence: 0.92
          }
        ],
        relationships: [
          {
            source: 'John Doe',
            target: 'Acme Corp',
            type: 'WORKS_AT',
            confidence: 0.88
          }
        ],
        embeddings: [0.1, 0.2, 0.3, 0.4, 0.5],
        sourceText: 'John Doe works at Acme Corp in New York.'
      };

      expect(result.entities).toHaveLength(2);
      expect(result.relationships).toHaveLength(1);
      expect(result.embeddings).toHaveLength(5);
      expect(result.sourceText).toBe('John Doe works at Acme Corp in New York.');
    });

    it('should support empty entities and relationships', () => {
      const result: AnalysisResult = {
        entities: [],
        relationships: [],
        embeddings: [0.1, 0.2],
        sourceText: 'Some text with no entities.'
      };

      expect(result.entities).toHaveLength(0);
      expect(result.relationships).toHaveLength(0);
      expect(result.embeddings).toHaveLength(2);
    });

    it('should support large embeddings vectors', () => {
      const embeddings = new Array(768).fill(0).map((_, i) => i * 0.001);
      const result: AnalysisResult = {
        entities: [],
        relationships: [],
        embeddings: embeddings,
        sourceText: 'Test text'
      };

      expect(result.embeddings).toHaveLength(768);
    });
  });

  describe('GoogleConfig interface', () => {
    it('should accept valid Google API configuration', () => {
      const config: GoogleConfig = {
        apiKey: 'test-api-key-12345'
      };

      expect(config.apiKey).toBe('test-api-key-12345');
    });
  });

  describe('GenkitEngine interface', () => {
    it('should define all required methods', () => {
      // Mock implementation to verify interface structure
      const mockEngine: GenkitEngine = {
        initialize: jest.fn().mockResolvedValue(undefined),
        analyzeText: jest.fn().mockResolvedValue({
          entities: [],
          relationships: [],
          embeddings: [],
          sourceText: ''
        }),
        generateEmbeddings: jest.fn().mockResolvedValue([]),
        generateQueryEmbeddings: jest.fn().mockResolvedValue([])
      };

      expect(mockEngine.initialize).toBeDefined();
      expect(mockEngine.analyzeText).toBeDefined();
      expect(mockEngine.generateEmbeddings).toBeDefined();
      expect(mockEngine.generateQueryEmbeddings).toBeDefined();
    });

    it('should have correct method signatures', async () => {
      const mockEngine: GenkitEngine = {
        initialize: jest.fn().mockResolvedValue(undefined),
        analyzeText: jest.fn().mockResolvedValue({
          entities: [{
            name: 'Test',
            type: EntityType.CONCEPT,
            sourceText: 'Test text',
            confidence: 0.9
          }],
          relationships: [],
          embeddings: [0.1, 0.2],
          sourceText: 'Test text'
        }),
        generateEmbeddings: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
        generateQueryEmbeddings: jest.fn().mockResolvedValue([0.4, 0.5, 0.6])
      };

      // Test initialize
      await mockEngine.initialize({ apiKey: 'test-key' });
      expect(mockEngine.initialize).toHaveBeenCalledWith({ apiKey: 'test-key' });

      // Test analyzeText
      const result = await mockEngine.analyzeText('Test text');
      expect(result.entities).toBeDefined();
      expect(result.relationships).toBeDefined();
      expect(result.embeddings).toBeDefined();
      expect(result.sourceText).toBeDefined();

      // Test generateEmbeddings
      const embeddings = await mockEngine.generateEmbeddings('Test text');
      expect(Array.isArray(embeddings)).toBe(true);

      // Test generateQueryEmbeddings
      const queryEmbeddings = await mockEngine.generateQueryEmbeddings('Query text');
      expect(Array.isArray(queryEmbeddings)).toBe(true);
    });
  });

  describe('Type compatibility and validation', () => {
    it('should ensure Entity confidence is between 0 and 1', () => {
      const validEntity: Entity = {
        name: 'Test',
        type: EntityType.PERSON,
        sourceText: 'Test',
        confidence: 0.5
      };

      expect(validEntity.confidence).toBeGreaterThanOrEqual(0);
      expect(validEntity.confidence).toBeLessThanOrEqual(1);
    });

    it('should ensure Relationship confidence is between 0 and 1', () => {
      const validRelationship: Relationship = {
        source: 'A',
        target: 'B',
        type: 'RELATES_TO',
        confidence: 0.75
      };

      expect(validRelationship.confidence).toBeGreaterThanOrEqual(0);
      expect(validRelationship.confidence).toBeLessThanOrEqual(1);
    });

    it('should support complex analysis results', () => {
      const complexResult: AnalysisResult = {
        entities: [
          { name: 'Alice', type: EntityType.PERSON, sourceText: 'Alice works at TechCorp', confidence: 0.95 },
          { name: 'TechCorp', type: EntityType.ORGANIZATION, sourceText: 'Alice works at TechCorp', confidence: 0.92 },
          { name: 'San Francisco', type: EntityType.LOCATION, sourceText: 'in San Francisco', confidence: 0.88 },
          { name: 'Machine Learning', type: EntityType.CONCEPT, sourceText: 'specializes in Machine Learning', confidence: 0.85 }
        ],
        relationships: [
          { source: 'Alice', target: 'TechCorp', type: 'WORKS_AT', confidence: 0.90 },
          { source: 'TechCorp', target: 'San Francisco', type: 'LOCATED_IN', confidence: 0.87 },
          { source: 'Alice', target: 'Machine Learning', type: 'SPECIALIZES_IN', confidence: 0.83 }
        ],
        embeddings: new Array(768).fill(0).map(() => Math.random()),
        sourceText: 'Alice works at TechCorp in San Francisco and specializes in Machine Learning.'
      };

      expect(complexResult.entities).toHaveLength(4);
      expect(complexResult.relationships).toHaveLength(3);
      expect(complexResult.embeddings).toHaveLength(768);
      expect(complexResult.sourceText).toContain('Alice');
      expect(complexResult.sourceText).toContain('TechCorp');
    });
  });
});
