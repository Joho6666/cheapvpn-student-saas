export class ProviderOperationUnsupportedError extends Error {
  constructor(operation) {
    super(`Provider operation is not supported: ${operation}`);
    this.name = "ProviderOperationUnsupportedError";
    this.code = "PROVIDER_OPERATION_UNSUPPORTED";
    this.status = 501;
  }
}

export class ProviderAdapter {
  async getStatus() { throw new ProviderOperationUnsupportedError("getStatus"); }
  async getSubscription() { throw new ProviderOperationUnsupportedError("getSubscription"); }
  async getUsage() { throw new ProviderOperationUnsupportedError("getUsage"); }
  async createCustomer() { throw new ProviderOperationUnsupportedError("createCustomer"); }
  async renewCustomer() { throw new ProviderOperationUnsupportedError("renewCustomer"); }
  async disableCustomer() { throw new ProviderOperationUnsupportedError("disableCustomer"); }
}
