export interface MementoWriter {
  update(key: string, value: unknown): PromiseLike<void>;
}

export class SerializedMementoWriter {
  private pending = Promise.resolve();

  constructor(
    private readonly memento: MementoWriter,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  update(key: string, value: unknown): void {
    const write = async (): Promise<void> => void (await this.memento.update(key, value));
    this.pending = this.pending.then(write, write).catch((error) => {
      this.onError(error);
    });
  }

  flush(): Promise<void> {
    return this.pending;
  }
}
