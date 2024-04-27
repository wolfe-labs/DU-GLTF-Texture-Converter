import path from 'path';
import os from 'os';
import { env } from 'process';
import { existsSync as fileExists, promises as fs } from 'fs';
import EventEmitter from 'node:events';

import { Document, JSONDocument, Material, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import BaseColorsTransform from './commands/BaseColorsTransform';

import { EventType, MaterialDefinition, MaterialDefinitions, MaterialPair, ProcessingQueueCommand, ProcessingQueueCommandFunction } from './types';

export default class DuMeshTransformer {
  // Keeps track of all commands on the current processing queue
  private pendingCommands: ProcessingQueueCommand[] = [];

  // The game installation directory
  private gameInstallationPath: string | null = null;

  // This is an event emitter for debugging
  private eventEmitter = new EventEmitter();

  ///////////////////////////////////////////////////////////////////
  // Internal API
  ///////////////////////////////////////////////////////////////////

  private static getDocumentIo(): NodeIO {
  // This is our reader
    return new NodeIO()
      .registerExtensions(ALL_EXTENSIONS);
  }

  /**
   * Queues a custom command for transforming the document
   */
  public queueTransform(command: ProcessingQueueCommandFunction, ...args: any[]): DuMeshTransformer {
    return this.queue(command, args);
  }

  /**
   * Queues a command for transforming the document
   */
  private queue(command: ProcessingQueueCommandFunction, ...args: any[]): DuMeshTransformer {
    // Queues the next command in the line
    this.pendingCommands.push({
      fn: command,
      args: args,
    });

    // Retuns a copy of this instance for chaining
    return this;
  }

  /**
   * Processes the current command queue, transforming the document
   */
  private async processQueue() {
    // Copies our commands and clears the queue to avoid double processing
    const queue = [...this.pendingCommands];
    this.pendingCommands = [];

    // Processes each command in sequence
    for (const command of queue) {
      await command.fn.apply(this, [{ document: this.gltfDocument, transformer: this }, ...command.args]);
    }
  }

  /**
   * Sends an event for upstream debugging
   */
  public notify(type: EventType, ...args: any[]) {
    this.events().emit(type, ...args);
  }

  ///////////////////////////////////////////////////////////////////
  // Public API
  ///////////////////////////////////////////////////////////////////

  /**
   * Returns a list of material definitions
   */
  public getMaterialDefinitions(): MaterialDefinitions {
    return this.materialDefinitions;
  }

  /**
   * Returns a game item id from a glTF material
   */
  public getGameItemIdFromGltfMaterial(material: Material): string {
    return (material.getExtras()['item_id'] as string) || material.getName();
  }

  /**
   * Returns a game material based on its game item id
   */
  public getGameMaterialFromItemId(itemId: string): MaterialDefinition | null {
    return this.getMaterialDefinitions().items[itemId] || null;
  }

  /**
   * Returns a game material from a glTF material
   */
  public getGameMaterialFromGltfMaterial(material: Material): MaterialDefinition | null {
    return this.getGameMaterialFromItemId(
      this.getGameItemIdFromGltfMaterial(material)
    );
  }

  /**
   * Returns materials who have game materials paired to them
   */
  public getGltfMaterialsWithGameMaterials(): MaterialPair[]
  {
    return this.gltfDocument.getRoot().listMaterials()
      .map((material) => {
        const gameMaterial = this.getGameMaterialFromGltfMaterial(material);
        
        return gameMaterial
          ? { material: material, gameMaterial: gameMaterial }
          : null;
      })
      .filter((pair) => !!pair) as MaterialPair[];
  }

  /**
   * Allows for listening for events from the mesh transformer
   */
  public events(): EventEmitter {
    return this.eventEmitter;
  }

  /**
   * Gets whether the game directory has been set
   */
  public isGameInstallationDirectorySet(): boolean
  {
    return !!this.gameInstallationPath;
  }

  /**
   * Sets the game installation directory to a custom path
   */
  public setGameInstallationDirectory(directory: string): DuMeshTransformer {
    // Checks if we have a valid data directory
    if (
      !fileExists(path.join(directory, 'Game', 'data'))
    ) {
      throw new Error(`Invalid game directory: ${directory}`);
    }

    // Saves and allows for the next command
    this.gameInstallationPath = directory;
    return this;
  }

  /**
   * Gets the game's data directory (if provided)
   */
  public getDataDirectory(): string | null
  {
    return this.isGameInstallationDirectorySet()
      ? path.join(this.gameInstallationPath!, 'Game', 'data')
      : null;
  }

  /**
   * Saves the file into a .glb or .gltb file
   * @param file The file you're saving to
   * @param saveAsJson Saves the file as .gltf instead of .glb, when enabled, a new directory is created per-mesh
   */
  public async saveToFile(file: string, saveAsJson: boolean = false) {
    // Processes any pending changes
    await this.processQueue();

    // Gets the file names
    const dir = path.dirname(file);
    const basename = path.basename(file, path.extname(file));

    // Writes the document
    if (saveAsJson) {
      // Creates the directory so we can isolate all the files properly
      const finaldir = path.join(dir, basename);
      if (!fileExists(finaldir)) {
        await fs.mkdir(finaldir);
      }

      // Writes actual file as .gltf
      await DuMeshTransformer.getDocumentIo().write(
        path.join(finaldir, `${basename}.gltf`),
        this.gltfDocument,
      );
    } else {
      // Let's just write a single-file .glb
      await DuMeshTransformer.getDocumentIo().write(
        path.join(dir, `${basename}.glb`),
        this.gltfDocument,
      );
    }
  }

  ///////////////////////////////////////////////////////////////////
  // Transforms
  ///////////////////////////////////////////////////////////////////

  public withBaseColors() {
    return this.queue(BaseColorsTransform);
  }

  ///////////////////////////////////////////////////////////////////
  // Constructors
  ///////////////////////////////////////////////////////////////////

  private constructor(
    private gltfDocument: Document,
    private materialDefinitions: MaterialDefinitions,
  ) {
    // Sets game install directory on Windows
    if (os.platform() == 'win32') {
      const defaultGameInstall = path.join(env.ProgramData || 'C:\\ProgramData', 'Dual Universe');

      if (fileExists(defaultGameInstall) && fileExists(path.join(defaultGameInstall, 'Game', 'data'))) {
        this.setGameInstallationDirectory(defaultGameInstall);
      }
    }

    // Pre-processes materials so we attach their item ids for later usage
    gltfDocument.getRoot().listMaterials().forEach((material) => {
      const itemId = this.getGameItemIdFromGltfMaterial(material);
      const itemMaterial = itemId
        ? this.getGameMaterialFromItemId(itemId)
        : null;

      if (itemId && itemMaterial) {
        // Renames the material to the right name
        material.setName(itemMaterial.title);

        // Sets a metadata field with the original item id
        material.setExtras({
          ...material.getExtras(),
          item_id: itemId,
        })
      }
    });
  }

  /**
   * Loads a glTF exported mesh from a GLTF Transform Document
   * @returns 
   */
  public static async fromDocument(document: Document, materialDefinitions?: MaterialDefinitions): Promise<DuMeshTransformer> {
    return new DuMeshTransformer(
      document,
      materialDefinitions || await fs.readFile(path.join(__dirname, '../../', 'data', 'materials.json')).then((data) => JSON.parse(data.toString())),
    );
  }

  /**
   * Loads a glTF exported mesh from a .gltf/.glb file
   * @returns 
   */
  public static async fromFile(file: string, materialDefinitions?: MaterialDefinitions): Promise<DuMeshTransformer> {
    return await DuMeshTransformer.fromDocument(
      await DuMeshTransformer.getDocumentIo().read(file),
      materialDefinitions,
    );
  }

  /**
   * Loads a glTF exported mesh from a JSON string
   * @returns 
   */
  public static async fromGltfJson(json: string|JSONDocument, materialDefinitions?: MaterialDefinitions): Promise<DuMeshTransformer> {
    return await DuMeshTransformer.fromDocument(
      await DuMeshTransformer.getDocumentIo().readJSON(
        (typeof json === 'string')
          ? JSON.parse(json)
          : json
      ),
      materialDefinitions,
    );
  }

  /**
   * Loads a glTF exported mesh from a GLB binary
   * @returns 
   */
  public static async fromGlbBinary(binaryData: Uint8Array, materialDefinitions?: MaterialDefinitions): Promise<DuMeshTransformer> {
    return DuMeshTransformer.fromDocument(
      await DuMeshTransformer.getDocumentIo().readBinary(binaryData),
      materialDefinitions,
    );
  }
}