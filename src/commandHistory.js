export class CommandHistory {
  constructor({ max = 50, onChange = () => {}, onExecute = () => {} } = {}) {
    this.max = max;
    this.onChange = onChange;
    this.onExecute = onExecute;
    this.undoStack = [];
    this.redoStack = [];
  }

  push(command) {
    this.undoStack.push(command);
    if (this.undoStack.length > this.max) this.undoStack.shift();
    this.redoStack = [];
    this.onChange(this.snapshot());
    this.onExecute();
  }

  undo() {
    if (!this.undoStack.length) return false;
    const command = this.undoStack.pop();
    command.undo();
    this.redoStack.push(command);
    this.onChange(this.snapshot());
    this.onExecute();
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    const command = this.redoStack.pop();
    command.redo();
    this.undoStack.push(command);
    this.onChange(this.snapshot());
    this.onExecute();
    return true;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.onChange(this.snapshot());
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  snapshot() {
    return {
      undoCount: this.undoStack.length,
      redoCount: this.redoStack.length,
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
    };
  }
}
