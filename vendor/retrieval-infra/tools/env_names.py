"""Project environment variables are named FABENCH_*; their former names RAVEN_* are still read.

A value comes from the new name when it is set, else from the former name, so existing
deployment env files keep working unchanged. A new name set to the empty string is used as
written and does not fall back. src/env-names.ts applies the same rule.
"""
import os

ENV_PREFIX = 'FABENCH_'
FORMER_ENV_PREFIX = 'RAVEN_'
_MISSING = object()


def former_env_name(name):
    """The former name of a project variable (FABENCH_X -> RAVEN_X), or None for other names."""
    return FORMER_ENV_PREFIX + name[len(ENV_PREFIX):] if name.startswith(ENV_PREFIX) else None


def project_env_name(name, environ=None):
    """The name a value is read from: name when it is set, else its former name when that is set."""
    environ = os.environ if environ is None else environ
    if name in environ:
        return name
    former = former_env_name(name)
    return former if former is not None and former in environ else name


def project_env(name, default=_MISSING, environ=None):
    """The value of name, or of its former name when name is unset.

    Without a default this behaves like os.environ[name] and raises KeyError naming the new
    variable when neither name is set.
    """
    environ = os.environ if environ is None else environ
    key = project_env_name(name, environ)
    if key in environ:
        return environ[key]
    if default is _MISSING:
        raise KeyError(name)
    return default
