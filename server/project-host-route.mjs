// Pure routing policy for a project observed on a specific host.
// Discovery of a project is not proof of execution authorization.
export function resolveExecutionHost({ project, requestedHost, ownerHost = 'mac', authorizedHosts = [] } = {}) {
  if (!project || typeof project !== 'object' || typeof project.name !== 'string')
    return { ok: false, error: 'project_not_found' };
  const host = requestedHost ?? (project.metadata_only && project.source_host === 'mac' ? ownerHost : null);
  if (host !== 'mac' && host !== 'vps') return { ok: false, error: 'host_unresolved' };
  if (project.metadata_only === true)
    return { ok: false, error: 'project_discovery_only', project: project.name, host };
  if (project.available !== true)
    return { ok: false, error: 'project_unavailable', project: project.name, host };
  if (!authorizedHosts.includes(host))
    return { ok: false, error: 'host_not_authorized', project: project.name, host };
  if (project.source_host && project.source_host !== host)
    return { ok: false, error: 'project_host_mismatch', project: project.name, host };
  return { ok: true, project: project.name, host };
}
