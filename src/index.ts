#!/usr/bin/env node

/**
 * GitLab MCP Server
 * 
 * This server provides tools and resources for interacting with GitLab repositories,
 * merge requests, issues, and more through the GitLab API.
 */

// Load environment variables from .env file
import dotenv from 'dotenv';
dotenv.config();

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance } from "axios";
import express from "express";
import cors from "cors";

// Import manager classes
import { IntegrationsManager } from "./integrations.js";
import { CiCdManager } from "./ci-cd.js";
import { UsersGroupsManager } from "./users-groups.js";

// Import utility modules
import { toolRegistry } from "./utils/tool-registry.js";
import { toolDefinitions } from "./utils/tools-data.js";
import { handleListResources, handleReadResource } from "./utils/resource-handlers.js";
import { handleApiError } from "./utils/response-formatter.js";
import { HandlerContext } from "./utils/handler-types.js";

// Get GitLab API token from environment variables
const GITLAB_API_TOKEN = process.env.GITLAB_API_TOKEN;
const GITLAB_API_URL = process.env.GITLAB_API_URL || 'https://gitlab.com/api/v4';

// Transport configuration
const TRANSPORT_TYPE = process.env.MCP_TRANSPORT || 'stdio';
const HTTP_PORT = parseInt(process.env.MCP_HTTP_PORT || '3000');

if (!GITLAB_API_TOKEN) {
  console.error("GITLAB_API_TOKEN environment variable is required");
  process.exit(1);
}

/**
 * GitLab MCP Server class
 */
class GitLabServer {
  private server: Server;
  private axiosInstance: AxiosInstance;
  private integrationsManager: IntegrationsManager;
  private ciCdManager: CiCdManager;
  private usersGroupsManager: UsersGroupsManager;
  private handlerContext: HandlerContext;

  constructor() {
    // Initialize server with metadata and capabilities
    this.server = new Server(
      {
        name: "mcp-gitlab",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
          resources: {}
        }
      }
    );
    
    // Create axios instance with base URL and auth headers
    this.axiosInstance = axios.create({
      baseURL: GITLAB_API_URL,
      headers: {
        'PRIVATE-TOKEN': GITLAB_API_TOKEN
      }
    });

    // Initialize manager classes
    this.integrationsManager = new IntegrationsManager(this.axiosInstance);
    this.ciCdManager = new CiCdManager(this.axiosInstance);
    this.usersGroupsManager = new UsersGroupsManager(this.axiosInstance);

    // Create handler context
    this.handlerContext = {
      axiosInstance: this.axiosInstance,
      integrationsManager: this.integrationsManager,
      ciCdManager: this.ciCdManager,
      usersGroupsManager: this.usersGroupsManager
    };

    // Setup request handlers
    this.setupRequestHandlers();
  }

  /**
   * Set up MCP request handlers
   */
  private setupRequestHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: toolDefinitions
      };
    });

    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return handleListResources(this.axiosInstance);
    });

    // Read GitLab resources
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return handleReadResource(request.params.uri, this.axiosInstance);
    });

    // Call GitLab tools
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const toolName = request.params.name;
        const handler = toolRegistry[toolName];
        
        if (!handler) {
          throw new McpError(ErrorCode.InvalidRequest, `Unknown tool: ${toolName}`);
        }
        
        return await handler(request.params, this.handlerContext);
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        throw handleApiError(error, 'Error executing GitLab operation');
      }
    });
  }

  /**
   * Start the GitLab MCP server with stdio transport
   */
  public async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  /**
   * Start the GitLab MCP server with HTTP transport
   */
  public async startHttp() {
    const app = express();
    
    // Enable CORS for all origins
    app.use(cors({
      origin: '*',
      methods: ['GET', 'POST', 'DELETE'],
      allowedHeaders: ['Content-Type', 'mcp-session-id'],
    }));

    // Parse JSON bodies
    app.use(express.json());

    // Store active transports by session ID
    const transports: Record<string, StreamableHTTPServerTransport> = {};

    // POST endpoint for client requests
    app.post('/mcp', async (req, res) => {
      try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports[sessionId]) {
          // Reuse existing session
          transport = transports[sessionId];
        } else if (!sessionId) {
          // New session initialization
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => {
              const id = Math.random().toString(36).substring(7);
              return id;
            },
            onsessioninitialized: (id) => {
              transports[id] = transport;
              console.log(`Session initialized: ${id}`);
            },
            onsessionclosed: (id) => {
              delete transports[id];
              console.log(`Session closed: ${id}`);
            }
          });

          transport.onclose = () => {
            if (transport.sessionId) {
              delete transports[transport.sessionId];
            }
          };

          await this.server.connect(transport);
        } else {
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Invalid session' },
            id: null
          });
          return;
        }

        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error('Error handling POST request:', error);
        res.status(500).json({ 
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    });

    // GET endpoint for SSE connections
    app.get('/mcp', async (req, res) => {
      try {
        const sessionId = req.headers['mcp-session-id'] as string;
        const transport = transports[sessionId];
        
        if (transport) {
          await transport.handleRequest(req, res);
        } else {
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Invalid session' },
            id: null
          });
        }
      } catch (error) {
        console.error('Error handling GET request:', error);
        res.status(500).send('Internal server error');
      }
    });

    // DELETE endpoint for session cleanup
    app.delete('/mcp', async (req, res) => {
      try {
        const sessionId = req.headers['mcp-session-id'] as string;
        const transport = transports[sessionId];
        
        if (transport) {
          await transport.handleRequest(req, res);
        } else {
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Invalid session' },
            id: null
          });
        }
      } catch (error) {
        console.error('Error handling DELETE request:', error);
        res.status(500).send('Internal server error');
      }
    });

    // Health check endpoint
    app.get('/health', (req, res) => {
      res.json({ 
        status: 'ok', 
        transport: 'streamable-http',
        activeSessions: Object.keys(transports).length
      });
    });

    // Start the HTTP server
    app.listen(HTTP_PORT, () => {
      console.log(`GitLab MCP server listening on http://localhost:${HTTP_PORT}/mcp`);
      console.log(`Health check available at http://localhost:${HTTP_PORT}/health`);
    });
  }
}

// Create and start the server with appropriate transport
const server = new GitLabServer();

if (TRANSPORT_TYPE === 'http') {
  console.log('Starting GitLab MCP server with HTTP transport...');
  server.startHttp().catch(error => {
    console.error("Failed to start HTTP server:", error);
    process.exit(1);
  });
} else {
  console.log('Starting GitLab MCP server with stdio transport...');
  server.start().catch(error => {
    console.error("Failed to start stdio server:", error);
    process.exit(1);
  });
}
