'use strict';
const SolidityParser = require("solidity-parser");
const ContractSourceBlock = require('./ContractSourceBlock');

const defaultImportResolver = require('./importResolver');

class ContractStructure {


    constructor(source, options = {}) {
        this.source = source;
        this.options = Object.assign({}, this.getDefaultOptions(), options);
        this.cache = {};
        this.parentStructures = new Map();
    }

    getDefaultOptions() {
        return {
            mergeWithParents: true,
            filePath: null,
            importResolver: defaultImportResolver
        };
    }


    toJSON(mergeWithParents) {

        var contractStructure = {
            contract: this.getContractInfo(),
            source: this.getSourceInfo(),
            parents: this.getParents(),
            events: this.getEvents(),
            functions: this.getFunctions(),
            constantFunctions: this.getConstantFunctions(),
        };


        if ((mergeWithParents == undefined  && this.options.mergeWithParents) ||
             mergeWithParents) contractStructure = this.mergeWithParents(contractStructure);


        return contractStructure;
    }


    mergeWithParents(contractStructure) {

        //what merged
        var inheritedStructure = {
            events: {},
            functions: {},
            constantFunctions: {},
        };
        var inheritKeys = Object.keys(inheritedStructure);

        var parents = this.getParents();
        for (var parent in  parents) {
            var parentStructure = this.getParentStructure(parents[parent]).toJSON();
            for (var key of inheritKeys)  Object.assign(inheritedStructure[key], parentStructure[key]);
        }

        for (var key of inheritKeys) {
            contractStructure[key] = Object.assign(inheritedStructure[key], contractStructure[key]);
        }

        return contractStructure;
    }


    getParentStructure(contractPath) {
        if (!this.parentStructures.has(contractPath)) {
            var importResolved = this.options.importResolver(contractPath, this.options.filePath);
            this.parentStructures.set(contractPath, new ContractStructure(importResolved.source, {filePath: importResolved.path}));
        }

        return this.parentStructures.get(contractPath);
    }

    getPragma() {
        this.getCached('pragma', () => {
            var pragmaStatement = this.getSourceStructure().body.find(elt => elt.type == 'PragmaStatement');
            return pragmaStatement.start_version ? pragmaStatement.start_version.operator + pragmaStatement.start_version.version : '';
        });
    }

    getImports() {
        return this.getCached('imports', () =>
            this.getSourceStructure().body.filter(elt => elt.type == 'ImportStatement')
                .map(elt => {
                    var defaultAlias = this.getContractNameFromPath(elt.from);
                    return {
                        from: elt.from,
                        alias: elt.alias || defaultAlias,
                        defaultAlias: defaultAlias
                    }
                }));
    }

    getContractNameFromPath(pathToContract) {
        return pathToContract.substr(pathToContract.lastIndexOf('/') + 1).replace('.sol', '');
    }

    getParents() {
        return this.getCached('parents', () => {
            var imports = this.getImports();
            var parents = {};
            for (var parentContract of this.getConractStatement().is.map(elt => elt.name)) {
                parents[parentContract] = this.resolveContractNameForImport(parentContract, imports);
            }
            return parents;
        });
    }


    resolveContractNameForImport(parentContract, imports) {
        for (var importClause of imports) {
            if (importClause.alias == parentContract) return importClause.from;
        }
        return null;
    }


    getCached(key, callback) {
        if (this.cache[key] != undefined) return this.cache[key];
        this.cache[key] = callback();
        return this.cache[key];
    }

    createBlockObject(blockData) {
        if (!blockData) return null;
        return new ContractSourceBlock(blockData, this.findAnnotation(blockData.start));
    }

    createBlockObjects(blockDataArray) {
        var blockObjects = {};
        if (!blockDataArray || !Object.keys(blockDataArray).length) return {};

        for (var blockData of blockDataArray) {
            blockObjects[blockData.name] = this.createBlockObject(blockData);
        }
        return blockObjects;
    }


    getSourceStructure() {
        return this.getCached('sourceStructure', () => SolidityParser.parse(this.source));
    }

    getConractStatement() {
        return this.getCached('contractStatement', () => this.getSourceStructure().body.find(elt => elt.type == 'ContractStatement'));
    }


//Contract structure parts

    getContractAnnotation() {
        return this.getCached('contractAnnotation', () => {
            var annotation = this.createBlockObject(this.getConractStatement()).getAnnotation();
            if (!annotation.title) annotation.title = this.getName();
            return annotation;
        });
    }

    getName() {
        return this.getConractStatement().name;
    }


    getContractInfo() {
        return Object.assign(
            {
                name: this.getName(),
                constructor: this.getConstructor()
            },
            this.getContractAnnotation()
        );

    }

    getSourceInfo() {
        return {
            pragma: this.getPragma(),
            imports: this.getImports(),
        };
    }


    getConstructor() {
        return this.getCached('constructorInfo', () => {
            var constructorBlock = this.getConractStatement().body ?
                this.getConractStatement().body.find(elt =>elt.type == 'FunctionDeclaration' && elt.name == this.getName()) : null;

            return this.createBlockObject(constructorBlock);
        });
    }


    getEvents() {
        return this.createBlockObjects(
            this.getConractStatement().body ?
                this.getConractStatement().body.filter(elt => elt.type == 'EventDeclaration') : []);
    }

    getFunctions() {
        return this.createBlockObjects(
            this.getConractStatement().body ?
                this.getConractStatement().body.filter(elt => elt.type == 'FunctionDeclaration' && elt.name != this.getName()
                && (!elt.modifiers || !elt.modifiers.find(subElt => subElt.name == 'constant' || subElt.name == 'internal'))) : {});
    }


    getConstantFunctions() {

        return this.getConractStatement().body ? Object.assign({},
            this.createBlockObjects(this.getConractStatement().body.filter(
                elt => elt[0] != undefined && elt[0].type == 'DeclarativeExpression' && elt[0].is_public == true).map(elt => elt[0])),
            this.createBlockObjects(this.getConractStatement().body.filter(
                elt => elt.type == 'FunctionDeclaration' && elt.name != this.getName() && elt.modifiers &&
                elt.modifiers.find(subElt => subElt.name == 'constant') && !elt.modifiers.find(subElt => subElt.name == 'internal')))
        ) : {};
    }


//Work with annotations

    findAnnotation(annotationEndPos) {

        var sourceLines = this.source.substring(0, annotationEndPos).split(/\r?\n/);

        var str = sourceLines.pop().trim();
        var annonations = [];
        while (!str || str.substring(0, 2) == '*/' || str.substring(0, 1) == '*' || str.substring(0, 3) == '/**') {

            var lineStr = str.replace(/\/?\*\/?/g, '').trim();
            if (lineStr) annonations.push(lineStr);

            var str = sourceLines.pop().trim();
        }
        return annonations.reverse().map(str => str.trim()).join("\n");
    }
}


module.exports = ContractStructure;