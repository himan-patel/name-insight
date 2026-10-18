/**
 * NameInsight core: domain validation and lookups, independent of any transport (REST, MCP, ...).
 */
export { ValidationError } from './errors';
export { isPublicAddress, normalizeDomain, normalizeDomainList } from './validation';
export { DomainService } from './domain-service';
export * from './schemas';
