'use strict';

const { Deta } = require('deta');
console.log("DETA_TOKEN", process.env.DETA_TOKEN)
const deta = Deta(process.env.DETA_TOKEN);
console.log(deta)

const crypto = require('crypto');
const {
  createReadStream,
  createWriteStream,
  rmdirSync,
  readdirSync,
  promises: fs,
} = require('fs');
const { pipeline, Transform } = require('stream');
const { pick, pickBy, sortBy, zip } = require('lodash');
const path = require('path');
const { format } = require('util');

const { getConfigModel } = require('../models/config');
const S3Bucket = require('../models/bucket');
const S3Object = require('../models/object');
const { concatStreams, walk, ensureDir } = require('../utils');
const { DirectoryService } = require('aws-sdk');

const S3RVER_SUFFIX = '%s._S3rver_%s';

class FilesystemStore {
  static decodeKeyPath(keyPath) {
    return process.platform === 'win32'
      ? keyPath.replace(/&../g, (ent) =>
          Buffer.from(ent.slice(1), 'hex').toString(),
        )
      : keyPath;
  }

  static encodeKeyPath(key) {
    return process.platform === 'win32'
      ? key.replace(
          /[<>:"\\|?*]/g,
          (ch) => '&' + Buffer.from(ch, 'utf8').toString('hex'),
        )
      : key;
  }

  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
  }

  // helpers
  getBucketPath(bucketName) {
    return path.join(this.rootDirectory, bucketName);
  }

  getResourcePath(bucket, key = '', resource) {
    const parts = FilesystemStore.encodeKeyPath(key).split('/');
    const suffix = format(S3RVER_SUFFIX, parts.pop(), resource);
    return path.join(this.rootDirectory, bucket, ...parts, suffix);
  }

  async getMetadata(bucket, key) {
    const drive = deta.Drive(bucket);

    const objectPath = this.getResourcePath(bucket, key, 'object');
    const metadataPath = this.getResourcePath(bucket, key, 'metadata.json');

    // this is expected to throw if the object doesn't exist
    // const fstat = await fs.stat(objectPath);
    const dstatBlob = await drive.get(metadataPath)
    const statText = await dstatBlob.text()
    const stat = JSON.parse(statText)
    const md5Blob = await drive.get(`${objectPath}.md5`)
    const md5 = await md5Blob.text()

    return {
      'content-type': stat['content-type'],
      etag: md5,
      'last-modified': stat.mtime,
      'content-length': stat.size,
    };
  }

  async putMetadata(bucket, key, metadata, md5) {
    const drive = deta.Drive(bucket);
    const metadataPath = this.getResourcePath(bucket, key, 'metadata.json');
    const md5Path = this.getResourcePath(bucket, key, 'object.md5');

    const json = {
      ...pick(metadata, S3Object.ALLOWED_METADATA),
      ...pickBy(metadata, (value, key) => key.startsWith('x-amz-meta-')),
      size: metadata['content-length'],
      mtime: new Date()
    };
    if (md5) await fs.writeFile(md5Path, md5);
    await fs.writeFile(metadataPath, JSON.stringify(json, null, 2));
    try {
      if (md5) drive.put(md5Path, {path:md5Path});
      drive.put(metadataPath, {path:metadataPath});
    } catch (error) {
      console.log("DETA ERROR::", error)
    }
  }

  async putContent(objectPath, content, bucket) {
    const drive = deta.Drive(bucket)
    if (Buffer.isBuffer(content)) {
      drive.put(objectPath, {data: content, contentType:'binary/octet-stream'}).catch((err)=>{console.log(err)})
    } else {
      try {
        var result = await new Promise((resolve, reject) => {
          let length = 0
          const data = []
          content.on('data', (d) => {
            length += d.length
            data.push(d)
          })
          content.on('end', () => {
            var fulldata = Buffer.concat(data)
            console.log(length)
            resolve(fulldata)
          })
        })
      } catch (err) {
        console.log(err)
      }
      //write to deta
      drive.put(objectPath, {data: result, contentType:'binary/octet-stream'}).catch((err)=>{console.log(err)})
    }
    // do it again for local file write
    return new Promise((resolve, reject) => {
      const writeStream = createWriteStream(objectPath);
      const md5Context = crypto.createHash('md5');

      if (Buffer.isBuffer(content)) {
        writeStream.end(content);
        md5Context.update(content);
        resolve([content.length, md5Context.digest('hex')]);
      } else {
        let totalLength = 0;
        pipeline(
          content,
          new Transform({
            transform(chunk, encoding, callback) {
              md5Context.update(chunk, encoding);
              totalLength += chunk.length;
              callback(null, chunk);
            },
          }),
          writeStream,
          (err) =>
            err
              ? reject(err)
              : resolve([totalLength, md5Context.digest('hex')]),
        );
      }
    });
  }
  // store implementation

  reset() {
    console.log("RESET called")
    const list = readdirSync(this.rootDirectory);
    for (const file of list) {
      rmdirSync(path.join(this.rootDirectory, file), { recursive: true });
    }
  }

  async listBuckets() {
    console.log("listBuckets called")
    const list = await fs.readdir(this.rootDirectory);
    const dlist = await drive.list({prefix: this.rootDirectory});
    console.log("list, dlist", list, dlist)
    const buckets = await Promise.all(
      list.map((filename) => this.getBucket(filename)),
    );
    console.log("listBuckets returns", buckets.filter(Boolean))
    return buckets.filter(Boolean);
  }

  async getBucket(bucket) {
    const drive = deta.Drive(bucket);
    console.log("getBucket called with ", bucket)
    const bucketPath = this.getBucketPath(bucket);
    try {
      const obj = await drive.get("stat")
    } catch (err) {
      console.log("getBucket Error:", err)
    }
    
    try {
      const stat = await fs.stat(bucketPath);
      if (!stat.isDirectory()) return null;
      console.log("getBucket returns ",new S3Bucket(bucket, stat.birthtime) )
      return new S3Bucket(bucket, stat.birthtime);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async putBucket(bucket) {
    const drive = deta.Drive(bucket);
    console.log('putBucket called with', bucket)
    const bucketPath = this.getBucketPath(bucket);
    await ensureDir(bucketPath);
    return this.getBucket(bucket);
  }

  async deleteBucket(bucket) {
    const drive = deta.Drive(bucket);
    console.log('deleteBucket called with ', bucket)
    return fs.rmdir(this.getBucketPath(bucket), { recursive: true });
  }

  async listObjects(bucket, options) {
    const drive = deta.Drive(bucket);
    console.log('listObjects called with ', bucket, options)
    const {
      delimiter = '',
      startAfter = '',
      prefix = '',
      maxKeys = Infinity,
    } = options;
    const bucketPath = this.getBucketPath(bucket);

    const delimiterEnc = FilesystemStore.encodeKeyPath(delimiter);
    const startAfterPath = [
      bucketPath,
      FilesystemStore.encodeKeyPath(startAfter),
    ].join('/');
    const prefixPath = [bucketPath, FilesystemStore.encodeKeyPath(prefix)].join(
      '/',
    );

    const it = walk(bucketPath, (dirPath) => {
      // avoid directories occurring before the startAfter parameter
      if (dirPath < startAfterPath && startAfterPath.indexOf(dirPath) === -1) {
        return false;
      }
      if (dirPath.startsWith(prefixPath)) {
        if (
          delimiterEnc &&
          dirPath.slice(prefixPath.length).indexOf(delimiterEnc) !== -1
        ) {
          // avoid directories occurring beneath a common prefix
          return false;
        }
      } else if (!prefixPath.startsWith(dirPath)) {
        // avoid directories that do not intersect with any part of the prefix
        return false;
      }
      return true;
    });

    const commonPrefixes = new Set();
    const objectSuffix = format(S3RVER_SUFFIX, '', 'object');
    const keys = [];
    let isTruncated = false;
    for (const keyPath of it) {
      if (!keyPath.endsWith(objectSuffix)) {
        continue;
      }

      const key = FilesystemStore.decodeKeyPath(
        keyPath.slice(bucketPath.length + 1, -objectSuffix.length),
      );

      if (key <= startAfter || !key.startsWith(prefix)) {
        continue;
      }

      if (delimiter) {
        const idx = key.slice(prefix.length).indexOf(delimiter);
        if (idx !== -1) {
          // add to common prefixes before filtering this key out
          commonPrefixes.add(key.slice(0, prefix.length + idx + 1));
          continue;
        }
      }

      if (keys.length < maxKeys) {
        keys.push(key);
      } else {
        isTruncated = true;
        break;
      }
    }

    const metadataArr = await Promise.all(
      keys.map((key) =>
        this.getMetadata(bucket, key).catch((err) => {
          if (err.code === 'ENOENT') return undefined;
          throw err;
        }),
      ),
    );
    console.log("listObjects returns", {
      objects: zip(keys, metadataArr)
        .filter(([, metadata]) => metadata !== undefined)
        .map(([key, metadata]) => new S3Object(bucket, key, null, metadata)),
      commonPrefixes: [...commonPrefixes].sort(),
      isTruncated,
    })
    return {
      objects: zip(keys, metadataArr)
        .filter(([, metadata]) => metadata !== undefined)
        .map(([key, metadata]) => new S3Object(bucket, key, null, metadata)),
      commonPrefixes: [...commonPrefixes].sort(),
      isTruncated,
    };
  }

  async existsObject(bucket, key) {
    const drive = deta.Drive(bucket);
    console.log("existsObject called with", bucket, key)
    const objectPath = this.getResourcePath(bucket, key, 'object');
    try {
      await fs.stat(objectPath);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  async getObject(bucket, key, options) {
    const drive = deta.Drive(bucket);
    drive.list().then((result)=>{console.log(result)}).catch((err)=>{console.log(err)})
    console.log("getObject called with", bucket, key, options)
    try {
      const metadata = await this.getMetadata(bucket, key);
      const lastByte = Math.max(0, Number(metadata['content-length']) - 1);
      const range = {
        start: (options && options.start) || 0,
        end: Math.min((options && options.end) || Infinity, lastByte),
      };

      if (range.start < 0 || Math.min(range.end, lastByte) < range.start) {
        // the range is not satisfiable
        const object = new S3Object(bucket, key, null, metadata);
        if (options && (options.start !== undefined || options.end)) {
          object.range = range;
        }
        return object;
      }

      var objectPath = this.getResourcePath(bucket, key, 'object')
      const blob = await drive.get(objectPath)
      const content = blob.stream()
      
      const object = new S3Object(bucket, key, content, metadata);
      if (options && (options.start !== undefined || options.end)) {
        object.range = range;
      }
      return object;
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async putObject(object) {
    console.log("putObject called with ", object.key, object.bucket)
    const drive = deta.Drive(object.bucket)
    const objectPath = this.getResourcePath(
      object.bucket,
      object.key,
      'object',
    );

    await ensureDir(path.dirname(objectPath));
    const [size, md5] = await this.putContent(objectPath, object.content, object.bucket);
    await this.putMetadata(object.bucket, object.key, object.metadata, md5);
    console.log("putObject returns ", {size, md5})
    return { size, md5 };
  }

  async copyObject(
    srcBucket,
    srcKey,
    destBucket,
    destKey,
    replacementMetadata,
  ) {
    const srcObjectPath = this.getResourcePath(srcBucket, srcKey, 'object');
    const destObjectPath = this.getResourcePath(destBucket, destKey, 'object');

    if (srcObjectPath !== destObjectPath) {
      await ensureDir(path.dirname(destObjectPath));
      await fs.copyFile(srcObjectPath, destObjectPath);
    }

    if (replacementMetadata) {
      await this.putMetadata(destBucket, destKey, replacementMetadata);
      return this.getMetadata(destBucket, destKey);
    } else {
      if (srcObjectPath !== destObjectPath) {
        await Promise.all([
          fs.copyFile(
            this.getResourcePath(srcBucket, srcKey, 'metadata.json'),
            this.getResourcePath(destBucket, destKey, 'metadata.json'),
          ),
          fs.copyFile(
            this.getResourcePath(srcBucket, srcKey, 'object.md5'),
            this.getResourcePath(destBucket, destKey, 'object.md5'),
          ),
        ]);
      }
      return this.getMetadata(destBucket, destKey);
    }
  }

  async deleteObject(bucket, key) {
    const drive = deta.Drive(bucket);
    await Promise.all(
      [
        this.getResourcePath(bucket, key, 'object'),
        this.getResourcePath(bucket, key, 'object.md5'),
        this.getResourcePath(bucket, key, 'metadata.json'),
      ].map((filePath) =>
        fs.unlink(filePath).catch((err) => {
          if (err.code !== 'ENOENT') throw err;
        }),
      ),
    );
    // clean up empty directories
    const bucketPath = this.getBucketPath(bucket);
    const parts = key.split('/');
    // the last part isn't a directory (it's embedded into the file name)
    parts.pop();
    while (
      parts.length &&
      !readdirSync(path.join(bucketPath, ...parts)).length
    ) {
      await fs.rmdir(path.join(bucketPath, ...parts));
      parts.pop();
    }
  }

  async initiateUpload(bucket, key, uploadId, metadata) {
    const uploadDir = path.join(
      this.getResourcePath(bucket, undefined, 'uploads'),
      uploadId,
    );

    await ensureDir(uploadDir);

    await Promise.all([
      fs.writeFile(path.join(uploadDir, 'key'), key),
      fs.writeFile(path.join(uploadDir, 'metadata'), JSON.stringify(metadata)),
    ]);
  }

  async putPart(bucket, uploadId, partNumber, content) {
    const drive = deta.Drive(bucket);
    console.log("putPart called with ", bucket, uploadId, partNumber, content)
    const partPath = path.join(
      this.getResourcePath(bucket, undefined, 'uploads'),
      uploadId,
      partNumber.toString(),
    );

    await ensureDir(path.dirname(partPath));

    const [size, md5] = await this.putContent(partPath, content, bucket);
    await fs.writeFile(`${partPath}.md5`, md5);
    console.log("putPart called with ", {size, md5})
    return { size, md5 };
  }

  async putObjectMultipart(bucket, uploadId, parts) {
    const drive = deta.Drive(bucket);
    console.log("putObjectMultipart called with ", bucket, uploadId, parts)
    const uploadDir = path.join(
      this.getResourcePath(bucket, undefined, 'uploads'),
      uploadId,
    );
    const [key, metadata] = await Promise.all([
      fs.readFile(path.join(uploadDir, 'key')).then((data) => data.toString()),
      fs.readFile(path.join(uploadDir, 'metadata')).then(JSON.parse),
    ]);
    const partStreams = sortBy(parts, (part) => part.number).map((part) =>
      createReadStream(path.join(uploadDir, part.number.toString())),
    );
    const object = new S3Object(
      bucket,
      key,
      concatStreams(partStreams),
      metadata,
    );
    const result = await this.putObject(object);
    await fs.rmdir(uploadDir, { recursive: true });
    console.log("putObjectMultipart returns ", result)
    return result;
  }

  async getSubresource(bucket, key, resourceType) {
    const drive = deta.Drive(bucket);
    const resourcePath = this.getResourcePath(
      bucket,
      key,
      `${resourceType}.xml`,
    );

    const Model = getConfigModel(resourceType);

    try {
      const data = await fs.readFile(resourcePath);
      return new Model(data.toString());
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async putSubresource(bucket, key, resource) {
    const drive = deta.Drive(bucket);
    console.log("putSubresource called with ", bucket, key, resource)
    const resourcePath = this.getResourcePath(
      bucket,
      key,
      `${resource.type}.xml`,
    );
    await fs.writeFile(resourcePath, resource.toXML(2));
  }

  async deleteSubresource(bucket, key, resourceType) {
    const drive = deta.Drive(bucket);
    console.log("deleteSubresource called with ", bucket, key, resourceType)
    const resourcePath = this.getResourcePath(
      bucket,
      key,
      `${resourceType}.xml`,
    );
    try {
      await fs.unlink(resourcePath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

module.exports = FilesystemStore;
